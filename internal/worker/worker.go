package worker

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"time"

	"github.com/MmedaraJ/fastforge/internal/jobs"
	"github.com/MmedaraJ/fastforge/internal/ladder"
	"github.com/MmedaraJ/fastforge/internal/probe"
	"github.com/MmedaraJ/fastforge/internal/store"
	"github.com/MmedaraJ/fastforge/internal/transcode"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
)

type TranscodeWorker struct {
	river.WorkerDefaults[jobs.TranscodeArgs]
	Pool *pgxpool.Pool
}

func (w *TranscodeWorker) Work(ctx context.Context, job *river.Job[jobs.TranscodeArgs]) error {
	id := job.Args.AssetID

	storagePath, err := store.ClaimAsset(ctx, w.Pool, id, job.Attempt > 1)
	if errors.Is(err, store.ErrNotClaimable) {
		slog.Warn("asset not claimable; completing job", "asset_id", id, "attempt", job.Attempt)
		return nil // permanent
	}
	if err != nil {
		return fmt.Errorf("asset %s: %w", id, err) // transient
	}
	slog.Info("asset claimed", "asset_id", id, "attempt", job.Attempt)

	probeResult, err := probe.Probe(ctx, storagePath)
	if err != nil {
		return w.fail(ctx, id, job.Attempt, err) // permanent: bad media
	}
	if err := store.SaveProbeResult(ctx, w.Pool, id, probeResult); err != nil {
		return w.transitionErr(id, job.Attempt, err)
	}
	slog.Info("probed", "asset_id", id, "width", probeResult.Width,
		"height", probeResult.Height, "fps", probeResult.FPS, "duration_s", probeResult.DurationS)

	rungs, err := ladder.BuildLadder(probeResult, ladder.DefaultLadder, 6)
	if err != nil {
		return w.fail(ctx, id, job.Attempt, err) // permanent: unusable source
	}
	slog.Info("ladder built", "asset_id", id, "rungs", len(rungs))

	if err := w.encodeRungs(ctx, id, storagePath, rungs); err != nil {
		return w.fail(ctx, id, job.Attempt, err) // permanent: bad encode
	}
	if err := store.MarkReady(ctx, w.Pool, id); err != nil {
		return w.transitionErr(id, job.Attempt, err)
	}
	slog.Info("asset ready", "asset_id", id, "attempt", job.Attempt)
	return nil
}

// fail records a permanent problem on the asset and completes the job.
func (w *TranscodeWorker) fail(ctx context.Context, id string, attempt int, cause error) error {
	// Recording a failure is exactly when ctx is most likely already dead
	// (encode timeout, shutdown). WithoutCancel keeps the values and drops
	// the cancellation, so the write still lands.
	cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()

	if err := store.MarkFailed(cleanupCtx, w.Pool, id, cause.Error()); err != nil {
		return fmt.Errorf("asset %s: recording failure: %w", id, err) // transient → retry
	}
	slog.Error("asset failed", "asset_id", id, "attempt", attempt, "err", cause)
	return nil
}

// transitionErr distinguishes a broken guard (invariant violation, don't retry)
// from a broken database (retry).
func (w *TranscodeWorker) transitionErr(id string, attempt int, err error) error {
	if errors.Is(err, store.ErrNoTransition) {
		slog.Error("status changed outside worker", "asset_id", id, "attempt", attempt)
		return nil
	}
	return fmt.Errorf("asset %s: %w", id, err)
}

// encodeRungs transcodes every rung into storage/renditions/<assetID>/ and
// records each finished file.
func (w *TranscodeWorker) encodeRungs(ctx context.Context, id, srcPath string, rungs []ladder.Rung) error {
	outDir := filepath.Join("storage", "renditions", id)
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		return fmt.Errorf("creating output dir: %w", err)
	}

	for _, r := range rungs {
		dst := filepath.Join(outDir, fmt.Sprintf("%dp.mp4", r.Height))

		encodeCtx, cancel := context.WithTimeout(ctx, 30*time.Minute)
		err := transcode.Run(encodeCtx, srcPath, r, dst)
		cancel() // not deferred: this is a loop

		if err != nil {
			// A killed encode leaves a truncated file with no moov atom.
			// Don't keep something unplayable on disk.
			os.Remove(dst)
			return fmt.Errorf("encoding %dp: %w", r.Height, err)
		}

		info, err := os.Stat(dst)
		if err != nil {
			return fmt.Errorf("stat %dp output: %w", r.Height, err)
		}

		if err := store.SaveRendition(ctx, w.Pool, id, r, dst, info.Size()); err != nil {
			return err
		}

		slog.Info("rendition encoded",
			"asset_id", id, "height", r.Height,
			"bytes", info.Size(), "path", dst)
	}
	return nil
}

// Timeout disables River's per-job deadline for transcode jobs. River's
// default is 60s; a 1080p encode of a 10-minute source takes minutes, so the
// default was killing FFmpeg mid-write and leaving MP4s with no moov atom.
// Each encode bounds itself with its own context in encodeRungs.
func (w *TranscodeWorker) Timeout(*river.Job[jobs.TranscodeArgs]) time.Duration {
	return -1
}
