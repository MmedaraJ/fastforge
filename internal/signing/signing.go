// Package signing makes and checks the two signed credentials the API hands
// out: playback tokens, sent with licence requests, and URL signatures, which
// put a time limit on media URLs.
//
// Both are HMAC-SHA256 over a message only the server can sign, because only
// it has the secret. Nothing is encrypted: anyone can read a token's claims,
// but no one can change them, or mint a new one, without the secret.
package signing

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
)

var (
	// ErrInvalid covers a malformed credential and a wrong signature alike.
	// Telling a caller which one it was would only help someone forging them.
	ErrInvalid = errors.New("invalid signature")
	ErrExpired = errors.New("expired")
)

var b64 = base64.RawURLEncoding

func decodeSecret(name, secretBase64 string) ([]byte, error) {
	secret, err := base64.StdEncoding.DecodeString(secretBase64)
	if err != nil || len(secret) < 32 {
		return nil, fmt.Errorf("%s must be at least 32 random bytes, base64", name)
	}
	return secret, nil
}

// sign is HMAC-SHA256 over a purpose and a message. The purpose ("playback",
// "media") keeps one kind of signature from ever passing as the other, even
// if both secrets were set to the same value by mistake.
func sign(secret []byte, purpose, message string) []byte {
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(purpose + "." + message))
	return mac.Sum(nil)
}

// ---------------------------------------------------------------------------
// Playback tokens: "<claims>.<signature>", both base64url, the claims JSON.
// A JWT is the same idea with a header naming the algorithm; leaving the
// header out means there's no algorithm for an attacker to choose.
// ---------------------------------------------------------------------------

// Claims is what a playback token says: which asset, until when.
type Claims struct {
	Asset   string `json:"asset"`
	Expires int64  `json:"exp"` // Unix seconds
}

// Tokens mints and verifies playback tokens.
type Tokens struct{ secret []byte }

func NewTokens(secretBase64 string) (*Tokens, error) {
	secret, err := decodeSecret("PLAYBACK_TOKEN_SECRET", secretBase64)
	if err != nil {
		return nil, err
	}
	return &Tokens{secret: secret}, nil
}

// Mint makes a token for one asset, valid for ttl from now.
func (t *Tokens) Mint(asset string, ttl time.Duration, now time.Time) string {
	claims, _ := json.Marshal(Claims{Asset: asset, Expires: now.Add(ttl).Unix()})
	body := b64.EncodeToString(claims)
	return body + "." + b64.EncodeToString(sign(t.secret, "playback", body))
}

// Verify checks the signature first and only then reads the claims: nothing
// a forger wrote is parsed before it's known to be the server's own.
func (t *Tokens) Verify(token string, now time.Time) (Claims, error) {
	body, sig, ok := strings.Cut(token, ".")
	if !ok {
		return Claims{}, ErrInvalid
	}
	got, err := b64.DecodeString(sig)
	// hmac.Equal takes the same time whichever byte differs. A plain ==
	// stops at the first wrong byte, and timing that leaks the signature.
	if err != nil || !hmac.Equal(got, sign(t.secret, "playback", body)) {
		return Claims{}, ErrInvalid
	}
	raw, err := b64.DecodeString(body)
	if err != nil {
		return Claims{}, ErrInvalid
	}
	var c Claims
	if err := json.Unmarshal(raw, &c); err != nil || c.Asset == "" {
		return Claims{}, ErrInvalid
	}
	if now.Unix() >= c.Expires {
		return Claims{}, ErrExpired
	}
	return c, nil
}

// ---------------------------------------------------------------------------
// URL signatures: a path segment "t/<expires>.<signature>/" in front of the
// asset's files, signing the expiry and the asset's folder, "packaged/<id>/".
//
// In the path rather than the query string because HLS playlists and DASH
// SegmentTemplates name their files with relative URLs, and a relative URL
// keeps the path it's resolved against but drops its query. With the
// signature in the path, every playlist, init segment and segment under
// /t/<sig>/packaged/<id>/ carries it without the files being rewritten.
// ---------------------------------------------------------------------------

// URLSigner signs and checks media URLs.
type URLSigner struct{ secret []byte }

func NewURLSigner(secretBase64 string) (*URLSigner, error) {
	secret, err := decodeSecret("MEDIA_URL_SECRET", secretBase64)
	if err != nil {
		return nil, err
	}
	return &URLSigner{secret: secret}, nil
}

// Sign returns the segment to put in front of folder ("packaged/<id>/"):
// "t/<expires>.<signature>/".
func (s *URLSigner) Sign(folder string, expires time.Time) string {
	exp := strconv.FormatInt(expires.Unix(), 10)
	return "t/" + exp + "." + b64.EncodeToString(sign(s.secret, "media", exp+"."+folder)) + "/"
}

// Verify checks a path "t/<expires>.<signature>/packaged/<id>/<file>" and
// returns it without the signature: "packaged/<id>/<file>". The signature
// covers the folder, so a URL signed for one asset opens no other.
func (s *URLSigner) Verify(path string, now time.Time) (string, error) {
	rest, ok := strings.CutPrefix(path, "t/")
	if !ok {
		return "", ErrInvalid
	}
	token, file, ok := strings.Cut(rest, "/")
	if !ok {
		return "", ErrInvalid
	}
	exp, sig, ok := strings.Cut(token, ".")
	if !ok {
		return "", ErrInvalid
	}
	// The folder is the first two elements: "packaged" and the asset ID.
	parts := strings.SplitN(file, "/", 3)
	if len(parts) != 3 || parts[0] != "packaged" || parts[1] == "" {
		return "", ErrInvalid
	}
	folder := parts[0] + "/" + parts[1] + "/"
	got, err := b64.DecodeString(sig)
	if err != nil || !hmac.Equal(got, sign(s.secret, "media", exp+"."+folder)) {
		return "", ErrInvalid
	}
	expires, err := strconv.ParseInt(exp, 10, 64)
	if err != nil {
		return "", ErrInvalid
	}
	if now.Unix() >= expires {
		return "", ErrExpired
	}
	return file, nil
}
