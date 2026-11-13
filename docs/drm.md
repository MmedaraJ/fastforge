# DRM and signed URLs

What's protected, how, and what it costs. Milestone 14.

## What's protected
- Every asset uploaded with `DRM_MODE=clearkey` (or `widevine-test`) is encrypted with its own
  16-byte content key, `cbcs` (AES-CBC, 1:9 pattern for video, whole blocks for audio), one set of
  CMAF segments for HLS and DASH.
- Media URLs carry an HMAC signature in the path (`/t/<expires>.<sig>/packaged/<id>/…`), checked by
  the API locally and by a Cloudflare Worker in front of a private R2 bucket in production.
- Clear Key is encryption, not DRM: the browser hands the key to page JavaScript. Widevine runs the
  same flow with the key kept inside the CDM.

## Keys
- `content_keys`: key ID plus the content key wrapped with AES-256-GCM under `CONTENT_KEK`
  (12-byte nonce, 16-byte key, 16-byte tag = 44 bytes). Asset ID and key ID are the additional data,
  so a wrapped key copied to another row won't unwrap.
- Rotating the KEK re-wraps 44 bytes per asset; no video is re-encrypted.
- Secrets: `CONTENT_KEK`, `PLAYBACK_TOKEN_SECRET`, `MEDIA_URL_SECRET`, each at least 32 bytes,
  none in git.

## Playback
1. `POST /assets/{id}/playback` → signed HLS and DASH URLs (6 h), a licence URL, a playback token (30 min).
2. The engine's CDM writes a licence request; the page posts it to `/license/clearkey` with
  `Authorization: Bearer <token>`.
3. The API checks the token, checks every requested key ID belongs to the token's asset (403 if not),
  and answers with the key.

## What it costs at startup (Step 7, headless Chromium 153, medians of 3)
| Encrypted minus clear | 2.5 Mbit/s, licence 0.12 s | 50 Mbit/s, licence 1.12 s |
|---|---|---|
| hls.js · HLS, keyids filter | +3 ms | +863 ms |
| Shaka · DASH | +28 ms | +742 ms |
| MSE · HLS | +25 ms | +896 ms |
| MSE · DASH | +31 ms | +925 ms |
| any engine, 5 s clear lead | −34 to +28 ms | −52 to +6 ms |

- The cost is whatever part of the licence round trip the first segment doesn't cover. Shaka asks
  from the MPD, hls.js from the playlist, and the MSE engine when its first audio segment lands.
- hls.js on Clear Key asked only after the first video segment (+92 and +1,125 ms) until a
  `generateRequest` filter built `keyids` from the KEY tag.
- Feed swipe to a preloaded encrypted video, 1.12 s licence: 1,198–1,250 ms before the licence
  preload, 75–100 ms after it (a clear video: 77–94 ms).

## Known gaps
- Safari: native HLS with FairPlay isn't built. Shaka · HLS refuses Clear Key HLS (error 4026);
  Clear Key plays over DASH there.
- Widevine through Google's test servers is wired up but untested here (Step 5).
- The CORS preflight before the first licence request is one round trip the throttle doesn't show
  (CDP: 1 to 6 ms).
- Preloaded licences are issued for videos that may never play: count plays from beacons.
- No key rotation, no persistent licences, no hardware-backed (L1) playback.