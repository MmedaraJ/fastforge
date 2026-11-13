package contentkey

import (
	"crypto/rand"
	"encoding/base64"
	"testing"
)

func newTestWrapper(t *testing.T) *Wrapper {
	t.Helper()
	kek := make([]byte, 32)
	rand.Read(kek)
	w, err := NewWrapper(base64.StdEncoding.EncodeToString(kek))
	if err != nil {
		t.Fatal(err)
	}
	return w
}

func TestWrapRoundTrip(t *testing.T) {
	w := newTestWrapper(t)
	k := New()
	wrapped := w.Wrap("asset-a", k)
	if len(wrapped) != WrappedSize {
		t.Fatalf("wrapped %d bytes, want %d", len(wrapped), WrappedSize)
	}
	got, err := w.Unwrap("asset-a", k.ID, wrapped)
	if err != nil {
		t.Fatal(err)
	}
	if got != k {
		t.Fatal("unwrapped key differs from the original")
	}
}

func TestUnwrapRefusesAnyMismatch(t *testing.T) {
	w := newTestWrapper(t)
	k := New()
	wrapped := w.Wrap("asset-a", k)

	flipped := append([]byte(nil), wrapped...)
	flipped[20] ^= 1
	otherID := k.ID
	otherID[0] ^= 1

	cases := map[string]func() error{
		"another asset's row": func() error { _, err := w.Unwrap("asset-b", k.ID, wrapped); return err },
		"another key ID":      func() error { _, err := w.Unwrap("asset-a", otherID, wrapped); return err },
		"one bit flipped":     func() error { _, err := w.Unwrap("asset-a", k.ID, flipped); return err },
		"a different KEK":     func() error { _, err := newTestWrapper(t).Unwrap("asset-a", k.ID, wrapped); return err },
		"truncated":           func() error { _, err := w.Unwrap("asset-a", k.ID, wrapped[:40]); return err },
	}
	for name, unwrap := range cases {
		if unwrap() == nil {
			t.Errorf("%s: unwrapped, want an error", name)
		}
	}
}

func TestWrapUsesAFreshNonceEachTime(t *testing.T) {
	w := newTestWrapper(t)
	k := New()
	if string(w.Wrap("a", k)) == string(w.Wrap("a", k)) {
		t.Fatal("two wraps of the same key are identical: the nonce isn't random")
	}
}

func TestNewWrapperRejectsBadKEKs(t *testing.T) {
	for name, kek := range map[string]string{
		"empty":    "",
		"not b64":  "not base64!",
		"16 bytes": base64.StdEncoding.EncodeToString(make([]byte, 16)),
	} {
		if _, err := NewWrapper(kek); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}
