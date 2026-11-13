#!/usr/bin/env bash
# Step 3's licence checks against your running API.
# usage: ./licence-check.sh <clear-key-asset-id> <another-clear-key-asset-id>
# Needs curl, jq and psql, with DATABASE_URL set (from .env if there is one).
set -u
API=${API:-http://localhost:8080}
ID=${1:?first argument: an asset ID packaged with DRM_MODE=clearkey}
OTHER=${2:?second argument: another Clear Key asset ID}
if [ -z "${DATABASE_URL:-}" ] && [ -f .env ]; then set -a; . ./.env; set +a; fi

# An asset's key ID as Clear Key writes it: base64url, no padding.
kid() {
  psql "$DATABASE_URL" -tAc "select translate(encode(key_id,'base64'), '+/=', '-_') from content_keys where asset_id='$1'" | tr -d '\n'
}
# check <what> <expected status> <actual status>
pass=0; fail=0
check() {
  if [ "$2" = "$3" ]; then echo "ok    $1: $3"; pass=$((pass+1))
  else echo "FAIL  $1: expected $2, got $3"; fail=$((fail+1)); fi
}
# post <path> <body> [curl args...]: prints the body, then the status on its own line
post() {
  local path=$1 body=$2; shift 2
  curl -s -X POST -H 'Content-Type: application/json' -d "$body" "$@" -w '\n%{http_code}' "$API$path"
}

KID=$(kid "$ID"); OTHER_KID=$(kid "$OTHER")
[ -n "$KID" ] && [ -n "$OTHER_KID" ] || { echo "no content_keys row for one of the assets"; exit 1; }

# 1. Start a playback: signed URLs, Clear Key, a token.
out=$(curl -s -X POST -w '\n%{http_code}' "$API/assets/$ID/playback")
check "POST /assets/<id>/playback" 200 "$(tail -n1 <<<"$out")"
PB=$(sed '$d' <<<"$out")
jq '{hls_url, dash_url, key_system: .drm.key_system, license_url: .drm.license_url, token: (.drm.token[0:20] + "…")}' <<<"$PB"
TOKEN=$(jq -r .drm.token <<<"$PB")
BODY="{\"kids\":[\"$KID\"],\"type\":\"temporary\"}"

# 2. No token.
check "licence, no token" 401 "$(post /license/clearkey "$BODY" | tail -n1)"

# 3. The token and this asset's key ID: one key back.
out=$(post /license/clearkey "$BODY" -H "Authorization: Bearer $TOKEN")
check "licence, token and its key ID" 200 "$(tail -n1 <<<"$out")"
sed '$d' <<<"$out" | jq -c '{keys: (.keys | length), type}'

# 4. The same token asking for another asset's key.
check "licence, another asset's key ID" 403 \
  "$(post /license/clearkey "{\"kids\":[\"$OTHER_KID\"],\"type\":\"temporary\"}" -H "Authorization: Bearer $TOKEN" | tail -n1)"

# 5. The token with one character added.
check "licence, tampered token" 401 "$(post /license/clearkey "$BODY" -H "Authorization: Bearer ${TOKEN}x" | tail -n1)"

# 6. The browser's preflight.
code=$(curl -s -o /dev/null -w '%{http_code}' -X OPTIONS "$API/license/clearkey" \
  -H 'Origin: http://localhost:5173' -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: authorization,content-type')
check "OPTIONS /license/clearkey (preflight)" 204 "$code"

# 7. A Clear Key asset's token at the Widevine endpoint.
check "Widevine endpoint, Clear Key token" 403 \
  "$(post /license/widevine 'not a real challenge' -H "Authorization: Bearer $TOKEN" | tail -n1)"

echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
