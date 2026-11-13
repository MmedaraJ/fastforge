package signing

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"strings"
	"testing"
	"time"
)

func secret() string {
	b := make([]byte, 32)
	rand.Read(b)
	return base64.StdEncoding.EncodeToString(b)
}

var now = time.Unix(1_800_000_000, 0)

func TestTokens(t *testing.T) {
	tokens, err := NewTokens(secret())
	if err != nil {
		t.Fatal(err)
	}
	tok := tokens.Mint("asset-a", 10*time.Minute, now)

	c, err := tokens.Verify(tok, now.Add(9*time.Minute))
	if err != nil || c.Asset != "asset-a" {
		t.Fatalf("fresh token: %v %+v", err, c)
	}
	if _, err := tokens.Verify(tok, now.Add(10*time.Minute)); !errors.Is(err, ErrExpired) {
		t.Errorf("at expiry: %v, want ErrExpired", err)
	}

	// Change the claims and keep the old signature: rejected.
	body, sig, _ := strings.Cut(tok, ".")
	raw, _ := base64.RawURLEncoding.DecodeString(body)
	forged := base64.RawURLEncoding.EncodeToString([]byte(strings.Replace(string(raw), "asset-a", "asset-b", 1))) + "." + sig
	if _, err := tokens.Verify(forged, now); !errors.Is(err, ErrInvalid) {
		t.Errorf("forged claims: %v, want ErrInvalid", err)
	}

	other, _ := NewTokens(secret())
	if _, err := other.Verify(tok, now); !errors.Is(err, ErrInvalid) {
		t.Errorf("another secret's token: %v, want ErrInvalid", err)
	}
	for _, junk := range []string{"", ".", "abc", "abc.def", tok + "x"} {
		if _, err := tokens.Verify(junk, now); err == nil {
			t.Errorf("%q verified", junk)
		}
	}
}

func TestURLSigner(t *testing.T) {
	s, err := NewURLSigner(secret())
	if err != nil {
		t.Fatal(err)
	}
	seg := s.Sign("packaged/a1/", now.Add(6*time.Hour))
	if !strings.HasPrefix(seg, "t/") || !strings.HasSuffix(seg, "/") {
		t.Fatalf("segment %q", seg)
	}

	for _, file := range []string{"master.m3u8", "720p/index.m3u8", "720p/3.m4s", "audio/en/init.mp4"} {
		got, err := s.Verify(seg+"packaged/a1/"+file, now)
		if err != nil || got != "packaged/a1/"+file {
			t.Errorf("%s: %q %v", file, got, err)
		}
	}
	if _, err := s.Verify(seg+"packaged/a2/master.m3u8", now); !errors.Is(err, ErrInvalid) {
		t.Errorf("another asset's folder: %v, want ErrInvalid", err)
	}
	if _, err := s.Verify(seg+"sources/a1.mov", now); !errors.Is(err, ErrInvalid) {
		t.Errorf("outside packaged/: %v, want ErrInvalid", err)
	}
	if _, err := s.Verify(seg+"packaged/a1/master.m3u8", now.Add(6*time.Hour)); !errors.Is(err, ErrExpired) {
		t.Errorf("at expiry: %v, want ErrExpired", err)
	}
	if _, err := s.Verify("packaged/a1/master.m3u8", now); !errors.Is(err, ErrInvalid) {
		t.Errorf("unsigned: %v, want ErrInvalid", err)
	}

	// A token signature must never pass as a URL signature, even under one
	// secret: the purpose prefix differs.
	same := secret()
	tokens, _ := NewTokens(same)
	urls, _ := NewURLSigner(same)
	tok := tokens.Mint("a1", time.Hour, now)
	_, sig, _ := strings.Cut(tok, ".")
	exp := "1800003600"
	if _, err := urls.Verify("t/"+exp+"."+sig+"/packaged/a1/master.m3u8", now); !errors.Is(err, ErrInvalid) {
		t.Errorf("token signature accepted as a URL signature: %v", err)
	}
}

func TestSecretsMustBeLongEnough(t *testing.T) {
	short := base64.StdEncoding.EncodeToString(make([]byte, 16))
	if _, err := NewTokens(short); err == nil {
		t.Error("16-byte token secret accepted")
	}
	if _, err := NewURLSigner(""); err == nil {
		t.Error("empty URL secret accepted")
	}
}
