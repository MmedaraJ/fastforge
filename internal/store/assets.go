// internal/store/assets.go
package store

import (
	"context"
	"errors"
	"fmt"

	"github.com/MmedaraJ/fastforge/internal/probe"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Sentinel errors let callers distinguish "guard refused" from "database broke"
// with errors.Is, instead of passing booleans around.
var (
	ErrNotClaimable = errors.New("asset not in 'queued' state")
	ErrNoTransition = errors.New("no row matched the expected status")
)

// ClaimAsset moves an asset into 'processing' and returns its source path.
//
// A fresh job may only claim a 'queued' asset. A retry (attempt > 1) may also
// reclaim one stuck in 'processing' — that's an attempt that died mid-work and
// never recorded anything. Without this, one crashed encode strands the asset
// in 'processing' forever.
func ClaimAsset(ctx context.Context, pool *pgxpool.Pool, assetID string, isRetry bool) (string, error) {
	var path string
	err := pool.QueryRow(ctx,
		`UPDATE assets
			SET status='processing', progress_stage='probing', updated_at=now()
		WHERE id=$1
		  AND (status='queued' OR ($2 AND status='processing'))
		RETURNING storage_path`,
		assetID, isRetry).Scan(&path)

	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrNotClaimable
	}
	if err != nil {
		return "", fmt.Errorf("claiming asset: %w", err)
	}
	return path, nil
}

// SaveProbeResult records what the source actually is and advances the stage.
func SaveProbeResult(ctx context.Context, pool *pgxpool.Pool, assetID string, p probe.Result) error {
	tag, err := pool.Exec(ctx,
		`UPDATE assets
			SET progress_stage='transcoding',
			    video_codec=$1, width=$2, height=$3, fps=$4, duration_s=$5, audio_codec=$6,
			    updated_at=now()
		WHERE id=$7 AND status='processing'`,
		p.VideoCodec, p.Width, p.Height, p.FPS, p.DurationS, p.AudioCodec, assetID)
	if err != nil {
		return fmt.Errorf("saving probe result: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNoTransition
	}
	return nil
}

func MarkFailed(ctx context.Context, pool *pgxpool.Pool, assetID, reason string) error {
	tag, err := pool.Exec(ctx,
		`UPDATE assets
			SET status='failed', progress_stage=NULL, error=$1, updated_at=now()
		WHERE id=$2 AND status='processing'`, reason, assetID)
	if err != nil {
		return fmt.Errorf("marking asset failed: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNoTransition
	}
	return nil
}

func MarkReady(ctx context.Context, pool *pgxpool.Pool, assetID string) error {
	tag, err := pool.Exec(ctx,
		`UPDATE assets SET status='ready', progress_stage=NULL, updated_at=now()
		WHERE id=$1 AND status='processing'`, assetID)
	if err != nil {
		return fmt.Errorf("marking asset ready: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNoTransition
	}
	return nil
}
