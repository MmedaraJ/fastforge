package store

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ErrNoContentKey means the asset has no content key: it's clear, or Google's
// test key server holds its key.
var ErrNoContentKey = errors.New("no content key for this asset")

// SaveContentKey stores the asset's wrapped key unless it already has one,
// then returns whichever is stored. A retried job therefore keeps its first
// key, and two attempts racing can't leave the asset with two.
func SaveContentKey(ctx context.Context, pool *pgxpool.Pool, assetID string, keyID [16]byte, wrapped []byte) ([16]byte, []byte, error) {
	if _, err := pool.Exec(ctx,
		`INSERT INTO content_keys (asset_id, key_id, wrapped_key) VALUES ($1, $2, $3)
		 ON CONFLICT (asset_id) DO NOTHING`, assetID, keyID[:], wrapped); err != nil {
		return [16]byte{}, nil, fmt.Errorf("saving content key: %w", err)
	}
	return ContentKey(ctx, pool, assetID)
}

// ContentKey returns the asset's key ID and wrapped key.
func ContentKey(ctx context.Context, pool *pgxpool.Pool, assetID string) ([16]byte, []byte, error) {
	var keyID [16]byte
	var id, wrapped []byte
	err := pool.QueryRow(ctx,
		`SELECT key_id, wrapped_key FROM content_keys WHERE asset_id = $1`, assetID).Scan(&id, &wrapped)
	if errors.Is(err, pgx.ErrNoRows) {
		return keyID, nil, ErrNoContentKey
	}
	if err != nil {
		return keyID, nil, fmt.Errorf("loading content key: %w", err)
	}
	copy(keyID[:], id)
	return keyID, wrapped, nil
}
