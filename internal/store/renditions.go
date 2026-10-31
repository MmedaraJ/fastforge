package store

import (
	"context"
	"fmt"

	"github.com/MmedaraJ/fastforge/internal/ladder"
	"github.com/jackc/pgx/v5/pgxpool"
)

// SaveRendition records one finished rendition. The UNIQUE(asset_id, height)
// constraint turns a re-run into an update instead of a duplicate — which is
// what makes the whole job idempotent.
//
// Note the id: unlike assets, nothing outside the database needs a rendition's
// id before the insert, so the database generates it.
func SaveRendition(ctx context.Context, pool *pgxpool.Pool, assetID string,
	r ladder.Rung, storagePath string, sizeBytes int64) error {

	_, err := pool.Exec(ctx,
		`INSERT INTO renditions
			(id, asset_id, storage_path, file_size_bytes, video_codec, width, height,
			fps, bitrate_kbps, maxrate_kbps, bufsize_kbps)
			VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
			ON CONFLICT (asset_id, height) DO UPDATE SET
			storage_path    = EXCLUDED.storage_path,
			file_size_bytes = EXCLUDED.file_size_bytes,
			video_codec     = EXCLUDED.video_codec,
			width           = EXCLUDED.width,
			fps             = EXCLUDED.fps,
			bitrate_kbps    = EXCLUDED.bitrate_kbps,
			maxrate_kbps    = EXCLUDED.maxrate_kbps,
			bufsize_kbps    = EXCLUDED.bufsize_kbps,
			vmaf            = NULL,
			created_at      = now()`,
		assetID, storagePath, sizeBytes, r.VideoCodec, r.Width, r.Height,
		r.FPS, r.BitrateKbps, r.MaxrateKbps, r.BufsizeKbps)

	if err != nil {
		return fmt.Errorf("saving %dp rendition: %w", r.Height, err)
	}
	return nil
}
