// Package contentkey makes content keys and keeps them wrapped.
//
// This is envelope encryption. Each asset's 16-byte AES key is stored
// encrypted ("wrapped") under one key-encryption key, the KEK. A database dump
// without the KEK reveals no key, and replacing the KEK means re-wrapping 44
// bytes per asset rather than re-encrypting any video.
package contentkey

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
)

// Key is one asset's content key and the ID that labels it. The ID is public
// (it's in every init segment and manifest); the Value is the secret.
type Key struct {
	ID    [16]byte
	Value [16]byte
}

// New makes a random key and key ID.
func New() Key {
	var k Key
	// Since Go 1.24, crypto/rand.Read never returns an error: if the system's
	// random source fails, the program stops rather than carry on with a
	// predictable key.
	rand.Read(k.ID[:])
	rand.Read(k.Value[:])
	return k
}

// WrappedSize is nonce + encrypted key + GCM tag: 12 + 16 + 16.
const WrappedSize = 44

// Wrapper wraps and unwraps content keys with the KEK.
type Wrapper struct {
	aead cipher.AEAD
}

// NewWrapper takes the KEK as it sits in CONTENT_KEK: 32 bytes, base64.
// Errors never include the value, so a bad KEK can't end up in a log.
func NewWrapper(kekBase64 string) (*Wrapper, error) {
	if kekBase64 == "" {
		return nil, errors.New("CONTENT_KEK is empty")
	}
	kek, err := base64.StdEncoding.DecodeString(kekBase64)
	if err != nil {
		return nil, errors.New("CONTENT_KEK is not valid base64")
	}
	if len(kek) != 32 {
		return nil, fmt.Errorf("CONTENT_KEK must decode to 32 bytes, not %d", len(kek))
	}
	block, err := aes.NewCipher(kek)
	if err != nil {
		return nil, err
	}
	// AES-256-GCM that makes its own random 12-byte nonce on every Seal and
	// puts it in front of the output (Go 1.24). Random nonces are safe for
	// about 2^32 wraps under one KEK, far beyond one key per asset.
	aead, err := cipher.NewGCMWithRandomNonce(block)
	if err != nil {
		return nil, err
	}
	return &Wrapper{aead: aead}, nil
}

// additionalData binds a wrapped key to its asset and key ID. GCM checks it
// when unwrapping, so a wrapped key copied onto another asset's row fails to
// open instead of quietly unlocking the wrong content.
func additionalData(assetID string, keyID [16]byte) []byte {
	return append([]byte(assetID+"|"), keyID[:]...)
}

// Wrap encrypts k's value for storage beside assetID.
func (w *Wrapper) Wrap(assetID string, k Key) []byte {
	return w.aead.Seal(nil, nil, k.Value[:], additionalData(assetID, k.ID))
}

// Unwrap reverses Wrap. It fails if the KEK is wrong, or if the wrapped bytes,
// the asset ID or the key ID differ in any bit from what was wrapped.
func (w *Wrapper) Unwrap(assetID string, keyID [16]byte, wrapped []byte) (Key, error) {
	if len(wrapped) != WrappedSize {
		return Key{}, fmt.Errorf("wrapped key is %d bytes, not %d", len(wrapped), WrappedSize)
	}
	value, err := w.aead.Open(nil, nil, wrapped, additionalData(assetID, keyID))
	if err != nil {
		return Key{}, errors.New("unwrapping content key: wrong KEK, or the stored row was altered")
	}
	k := Key{ID: keyID}
	copy(k.Value[:], value)
	return k, nil
}
