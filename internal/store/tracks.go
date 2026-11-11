package store

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Track is one audio or subtitle language an asset offers.
type Track struct {
	Kind      string // "audio" or "subtitles"
	Language  string // BCP 47, "" if the source didn't say
	Label     string
	IsDefault bool
	Path      string
}

// SaveTracks replaces the asset's tracks with these, in one transaction, so a
// re-run that packages different tracks leaves no stale rows behind.
func SaveTracks(ctx context.Context, pool *pgxpool.Pool, assetID string, tracks []Track) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("saving tracks: %w", err)
	}
	defer tx.Rollback(ctx)

	if _, err := tx.Exec(ctx, `DELETE FROM tracks WHERE asset_id = $1`, assetID); err != nil {
		return fmt.Errorf("saving tracks: %w", err)
	}
	for _, t := range tracks {
		if _, err := tx.Exec(ctx,
			`INSERT INTO tracks (asset_id, kind, language, label, is_default, path)
			 VALUES ($1, $2, $3, $4, $5, $6)`,
			assetID, t.Kind, t.Language, t.Label, t.IsDefault, t.Path); err != nil {
			return fmt.Errorf("saving %s track %q: %w", t.Kind, t.Language, err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("saving tracks: %w", err)
	}
	return nil
}
