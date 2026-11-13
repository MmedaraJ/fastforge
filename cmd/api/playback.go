package main

import (
	"bytes"
	"cmp"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/MmedaraJ/fastforge/internal/contentkey"
	"github.com/MmedaraJ/fastforge/internal/packager"
	"github.com/MmedaraJ/fastforge/internal/signing"
	"github.com/MmedaraJ/fastforge/internal/store"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	// A playback token only has to outlive the gap between asking to play
	// and the licence request: seconds normally, longer for a feed item
	// preloaded before it's swiped to.
	tokenTTL = 30 * time.Minute
	// A media URL has to outlive the viewing: every segment request carries it.
	mediaTTL = 6 * time.Hour
	// Google's Widevine test licence server, for widevine-test assets.
	widevineTestLicenseURL = "https://proxy.uat.widevine.com/proxy?provider=widevine_test"
)

// playbackServer is everything between "the viewer pressed play" and "the
// CDM has a key": signed URLs, playback tokens, and the licence endpoints.
type playbackServer struct {
	pool        *pgxpool.Pool
	mediaBase   string
	tokens      *signing.Tokens     // nil: encrypted assets can't be played
	urls        *signing.URLSigner  // nil: media URLs go out unsigned
	keys        *contentkey.Wrapper // nil: no Clear Key licences
	widevineURL string              // where Widevine licence requests are forwarded
	client      *http.Client
}

// newPlaybackServer reads its secrets from the environment. Each one is
// optional, so a laptop without DRM still runs, but a secret that is set and
// invalid stops the API: a typo must not quietly switch security off.
func newPlaybackServer(pool *pgxpool.Pool, mediaBase string) *playbackServer {
	p := &playbackServer{
		pool:        pool,
		mediaBase:   mediaBase,
		widevineURL: cmp.Or(os.Getenv("WIDEVINE_LICENSE_URL"), widevineTestLicenseURL),
		client:      &http.Client{Timeout: 10 * time.Second},
	}
	var err error
	if s := os.Getenv("PLAYBACK_TOKEN_SECRET"); s != "" {
		if p.tokens, err = signing.NewTokens(s); err != nil {
			log.Fatal(err)
		}
	} else {
		log.Println("PLAYBACK_TOKEN_SECRET is empty: encrypted assets can't be played")
	}
	if s := os.Getenv("MEDIA_URL_SECRET"); s != "" {
		if p.urls, err = signing.NewURLSigner(s); err != nil {
			log.Fatal(err)
		}
	} else {
		log.Println("MEDIA_URL_SECRET is empty: media URLs are unsigned")
	}
	if s := os.Getenv("CONTENT_KEK"); s != "" {
		if p.keys, err = contentkey.NewWrapper(s); err != nil {
			log.Fatalf("CONTENT_KEK: %v", err)
		}
	}
	return p
}

type playbackResponse struct {
	HLSURL    string    `json:"hls_url"`
	DASHURL   string    `json:"dash_url"`
	DRM       *drmInfo  `json:"drm"`
	ExpiresAt time.Time `json:"expires_at"`
}

type drmInfo struct {
	// The EME name: what the player passes to requestMediaKeySystemAccess.
	KeySystem string `json:"key_system"`
	// Relative to the API, like the media URLs in development.
	LicenseURL string `json:"license_url"`
	// Sent back as "Authorization: Bearer <token>" with each licence request.
	Token string `json:"token"`
}

// start answers POST /assets/{id}/playback: everything a player needs to
// begin, minted for this request. A POST, not part of GET /assets/{id},
// because it hands out credentials: a GET may be cached and served to
// someone else, and these must never be.
func (p *playbackServer) start(w http.ResponseWriter, r *http.Request) {
	assetID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid asset id")
		return
	}
	var status string
	var hlsPath, dashPath, drm *string
	err = p.pool.QueryRow(r.Context(),
		`SELECT status, hls_path, dash_path, drm FROM assets WHERE id = $1`, assetID,
	).Scan(&status, &hlsPath, &dashPath, &drm)
	if errors.Is(err, pgx.ErrNoRows) {
		writeJSONError(w, http.StatusNotFound, "asset not found")
		return
	}
	if err != nil {
		slog.Error("starting playback", "err", err, "asset_id", assetID)
		writeJSONError(w, http.StatusInternalServerError, "failed to start playback")
		return
	}
	// "ready" is set only after the upload finishes, so this is also what
	// stops a URL going out for files not yet in R2.
	if status != "ready" || hlsPath == nil || dashPath == nil {
		writeJSONError(w, http.StatusConflict, "asset is not ready: "+status)
		return
	}

	now := time.Now()
	resp := playbackResponse{
		HLSURL:    p.mediaURL(*hlsPath, now),
		DASHURL:   p.mediaURL(*dashPath, now),
		ExpiresAt: now.Add(mediaTTL).UTC(),
	}
	if drm != nil {
		if p.tokens == nil {
			writeJSONError(w, http.StatusServiceUnavailable, "this asset is encrypted and PLAYBACK_TOKEN_SECRET is not set")
			return
		}
		resp.DRM = &drmInfo{Token: p.tokens.Mint(assetID.String(), tokenTTL, now)}
		switch *drm {
		case packager.ModeClearKey:
			resp.DRM.KeySystem, resp.DRM.LicenseURL = "org.w3.clearkey", "/license/clearkey"
		case packager.ModeWidevineTest:
			resp.DRM.KeySystem, resp.DRM.LicenseURL = "com.widevine.alpha", "/license/widevine"
		}
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, resp)
}

// mediaURL turns a storage path into the URL a player fetches: signed for
// the asset's folder when MEDIA_URL_SECRET is set.
func (p *playbackServer) mediaURL(storagePath string, now time.Time) string {
	rel := strings.TrimPrefix(storagePath, "storage/") // packaged/<id>/master.m3u8
	if p.urls != nil {
		parts := strings.SplitN(rel, "/", 3)
		if len(parts) == 3 {
			rel = p.urls.Sign(parts[0]+"/"+parts[1]+"/", now.Add(mediaTTL)) + rel
		}
	}
	return p.mediaBase + "/" + rel
}

// authorize reads "Authorization: Bearer <token>" and checks it. On failure
// it has already answered 401.
func (p *playbackServer) authorize(w http.ResponseWriter, r *http.Request) (signing.Claims, bool) {
	if p.tokens == nil {
		writeJSONError(w, http.StatusServiceUnavailable, "PLAYBACK_TOKEN_SECRET is not set")
		return signing.Claims{}, false
	}
	token, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	claims, err := p.tokens.Verify(token, time.Now())
	if !ok || err != nil {
		w.Header().Set("WWW-Authenticate", `Bearer error="invalid_token"`)
		writeJSONError(w, http.StatusUnauthorized, "missing, invalid or expired playback token")
		return signing.Claims{}, false
	}
	return claims, true
}

// The W3C Clear Key licence formats (EME, section 9.1.3 and 9.1.4). Key IDs
// and keys are base64url without padding.
type clearKeyRequest struct {
	KIDs []string `json:"kids"`
	Type string   `json:"type"`
}

type clearKeyLicense struct {
	Keys []jwk  `json:"keys"`
	Type string `json:"type"`
}

// jwk is one key as a JSON Web Key: kty "oct" is a symmetric key.
type jwk struct {
	Kty string `json:"kty"`
	KID string `json:"kid"`
	K   string `json:"k"`
}

// clearKey answers POST /license/clearkey. The token says which asset this
// viewer may play; the request says which key IDs the CDM wants. A key goes
// back only if it is that asset's, so a token for one asset never unlocks
// another, whatever key IDs a caller asks for.
func (p *playbackServer) clearKey(w http.ResponseWriter, r *http.Request) {
	claims, ok := p.authorize(w, r)
	if !ok {
		return
	}
	if p.keys == nil {
		writeJSONError(w, http.StatusServiceUnavailable, "CONTENT_KEK is not set")
		return
	}
	var req clearKeyRequest
	// 4 kB holds hundreds of key IDs. Reading an unbounded body would let
	// anyone with a token make the server buffer as much as they send.
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&req); err != nil || len(req.KIDs) == 0 {
		writeJSONError(w, http.StatusBadRequest, "expected a Clear Key licence request")
		return
	}
	if req.Type != "" && req.Type != "temporary" {
		writeJSONError(w, http.StatusBadRequest, "only temporary licences are issued")
		return
	}

	keyID, wrapped, err := store.ContentKey(r.Context(), p.pool, claims.Asset)
	if errors.Is(err, store.ErrNoContentKey) {
		writeJSONError(w, http.StatusNotFound, "this asset has no Clear Key key")
		return
	}
	if err != nil {
		slog.Error("licence: loading key", "err", err, "asset_id", claims.Asset)
		writeJSONError(w, http.StatusInternalServerError, "failed to issue licence")
		return
	}

	license := clearKeyLicense{Type: "temporary"}
	for _, kid := range req.KIDs {
		requested, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(kid, "="))
		if err != nil || !bytes.Equal(requested, keyID[:]) {
			continue
		}
		key, err := p.keys.Unwrap(claims.Asset, keyID, wrapped)
		if err != nil {
			slog.Error("licence: unwrapping key", "err", err, "asset_id", claims.Asset)
			writeJSONError(w, http.StatusInternalServerError, "failed to issue licence")
			return
		}
		license.Keys = append(license.Keys, jwk{
			Kty: "oct",
			KID: base64.RawURLEncoding.EncodeToString(keyID[:]),
			K:   base64.RawURLEncoding.EncodeToString(key.Value[:]),
		})
	}
	if len(license.Keys) == 0 {
		writeJSONError(w, http.StatusForbidden, "none of the requested keys belong to this asset")
		return
	}
	slog.Info("licence issued", "asset_id", claims.Asset, "system", "clearkey")
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, license)
}

// widevine answers POST /license/widevine by forwarding the CDM's request to
// the Widevine licence server: a licence proxy. The request is opaque bytes
// signed by the CDM, so all this endpoint can check is the viewer's token
// and the asset; the licence server checks the rest.
func (p *playbackServer) widevine(w http.ResponseWriter, r *http.Request) {
	claims, ok := p.authorize(w, r)
	if !ok {
		return
	}
	var drm *string
	if err := p.pool.QueryRow(r.Context(), `SELECT drm FROM assets WHERE id = $1`, claims.Asset).Scan(&drm); err != nil ||
		drm == nil || *drm != packager.ModeWidevineTest {
		writeJSONError(w, http.StatusForbidden, "this asset is not a Widevine asset")
		return
	}
	// Licence requests are a few kB; service certificate requests smaller.
	challenge, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 64<<10))
	if err != nil || len(challenge) == 0 {
		writeJSONError(w, http.StatusBadRequest, "expected a Widevine licence request")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	upstream, err := http.NewRequestWithContext(ctx, http.MethodPost, p.widevineURL, bytes.NewReader(challenge))
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to forward licence request")
		return
	}
	upstream.Header.Set("Content-Type", "application/octet-stream")
	resp, err := p.client.Do(upstream)
	if err != nil {
		slog.Error("licence: forwarding", "err", err, "asset_id", claims.Asset)
		writeJSONError(w, http.StatusBadGateway, "the Widevine licence server didn't answer")
		return
	}
	defer resp.Body.Close()
	license, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil || resp.StatusCode != http.StatusOK {
		slog.Error("licence: refused upstream", "status", resp.StatusCode, "asset_id", claims.Asset)
		writeJSONError(w, http.StatusBadGateway, "the Widevine licence server refused the request")
		return
	}
	slog.Info("licence forwarded", "asset_id", claims.Asset, "system", "widevine")
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(license)
}

// requireSignedURL lets through only requests whose path carries a valid,
// unexpired signature, and hands the file server the path without it. With
// no MEDIA_URL_SECRET it lets everything through, as before.
func (p *playbackServer) requireSignedURL(next http.Handler) http.Handler {
	if p.urls == nil {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		file, err := p.urls.Verify(strings.TrimPrefix(r.URL.Path, "/"), time.Now())
		if err != nil {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		unsigned := r.Clone(r.Context())
		unsigned.URL.Path, unsigned.URL.RawPath = "/"+file, ""
		next.ServeHTTP(w, unsigned)
	})
}

// withPlaybackCORS lets a player on another origin call the playback and
// licence endpoints. An Authorization header makes a request "non-simple",
// so the browser first sends a preflight OPTIONS and waits for this answer;
// Max-Age lets it reuse the answer for ten minutes instead of asking again.
func withPlaybackCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
		w.Header().Set("Access-Control-Max-Age", "600")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}
