package worker

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/MmedaraJ/fastforge/internal/jobs"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
)

type TranscodeWorker struct {
	river.WorkerDefaults[jobs.TranscodeArgs]               // satisfies the interface bits
	Pool                                     *pgxpool.Pool // the backpack, struct-flavor
}

func (w *TranscodeWorker) Work(ctx context.Context, job *river.Job[jobs.TranscodeArgs]) error {
	tag, err := w.Pool.Exec(ctx,
		`UPDATE assets SET status='processing', updated_at=now()
		 WHERE id=$1 AND status='queued'`,
		job.Args.AssetID)
	if err != nil {
		return fmt.Errorf("claiming asset %s: %w", job.Args.AssetID, err)
	}
	if tag.RowsAffected() == 0 {
		slog.Warn("asset not claimable — already processed or missing; completing job",
			"asset_id", job.Args.AssetID, "attempt", job.Attempt)
		return nil
	}

	slog.Info("asset claimed", "asset_id", job.Args.AssetID, "attempt", job.Attempt)

	time.Sleep(5 * time.Second) // fake work, replaced by FFmpeg next

	tag, err = w.Pool.Exec(ctx,
		`UPDATE assets SET status='ready', updated_at=now()
		 WHERE id=$1 AND status='processing'`,
		job.Args.AssetID)
	if err != nil {
		return fmt.Errorf("marking asset %s ready: %w", job.Args.AssetID, err)
	}
	if tag.RowsAffected() == 0 {
		slog.Error("completion update matched no rows — status changed outside worker",
			"asset_id", job.Args.AssetID, "attempt", job.Attempt)
		return nil
	}

	slog.Info("asset ready", "asset_id", job.Args.AssetID, "attempt", job.Attempt)

	return nil
}
