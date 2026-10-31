package store

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

// NewPool opens a pgx connection pool and verifies the database is
// reachable. The caller owns the pool and must Close() it.
func NewPool(ctx context.Context, databaseURL string) (*pgxpool.Pool, error) {
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		return nil, fmt.Errorf("creating pgx pool: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("pinging database: %w", err)
	}
	return pool, nil
}

// SaveAudioTrack records the shared audio rendition — one per asset, not one
// per rung.
func SaveAudioTrack(ctx context.Context, pool *pgxpool.Pool, assetID, path string, bitrateKbps int) error {
	tag, err := pool.Exec(ctx,
		`UPDATE assets SET audio_path=$1, audio_bitrate_kbps=$2, updated_at=now()
		 WHERE id=$3 AND status='processing'`, path, bitrateKbps, assetID)
	if err != nil {
		return fmt.Errorf("saving audio track: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNoTransition
	}
	return nil
}
