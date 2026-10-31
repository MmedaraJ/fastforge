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
	"github.com/MmedaraJ/fastforge/internal/packager"
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

	rungs, err := ladder.BuildLadder(probeResult, ladder.DefaultLadder, ladder.SegmentSeconds)
	if err != nil {
		return w.fail(ctx, id, job.Attempt, err)
	}
	slog.Info("ladder built", "asset_id", id, "rungs", len(rungs))

	// Both the audio track and every video rung land here. Create it once, up
	// front. Before audio moved ahead of video this happened as a side effect
	// inside encodeRungs — an undeclared dependency that broke the moment the
	// two calls were reordered.
	if err := os.MkdirAll(renditionDir(id), 0o755); err != nil {
		return w.fail(ctx, id, job.Attempt, fmt.Errorf("creating rendition dir: %w", err))
	}

	// Audio first: it takes seconds, so a source with broken audio fails
	// before we spend minutes on video.
	var audioPath string
	if probeResult.AudioCodec != "" {
		track := ladder.BuildAudioTrack(ladder.DefaultLadder)
		audioPath, err = w.encodeAudio(ctx, id, storagePath, track)
		if err != nil {
			return w.fail(ctx, id, job.Attempt, err)
		}
	} else {
		slog.Info("source has no audio stream; packaging video only", "asset_id", id)
	}

	produced, err := w.encodeRungs(ctx, id, storagePath, rungs)
	if err != nil {
		return w.fail(ctx, id, job.Attempt, err)
	}

	if err := store.SetProgressStage(ctx, w.Pool, id, "packaging"); err != nil {
		return w.transitionErr(id, job.Attempt, err)
	}

	hlsPath, dashPath, err := w.packageAsset(ctx, id, produced, audioPath)
	if err != nil {
		return w.fail(ctx, id, job.Attempt, err)
	}
	if err := store.SavePackaging(ctx, w.Pool, id, hlsPath, dashPath); err != nil {
		return w.transitionErr(id, job.Attempt, err)
	}
	slog.Info("packaged", "asset_id", id, "hls", hlsPath, "dash", dashPath)

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

// renditionDir is the single definition of where an asset's encoded files go.
func renditionDir(id string) string {
	return filepath.Join("storage", "renditions", id)
}

// encodeRungs transcodes every rung into storage/renditions/<assetID>/,
// records each finished file, and returns them ready for packaging.
func (w *TranscodeWorker) encodeRungs(ctx context.Context, id, srcPath string, rungs []ladder.Rung) ([]packager.Input, error) {
	outDir := renditionDir(id)

	produced := make([]packager.Input, 0, len(rungs))

	for _, r := range rungs {
		dst := filepath.Join(outDir, fmt.Sprintf("%dp.mp4", r.Height))

		encodeCtx, cancel := context.WithTimeout(ctx, 30*time.Minute)
		err := transcode.RunVideo(encodeCtx, srcPath, r, dst)
		cancel() // not deferred: this is a loop

		if err != nil {
			os.Remove(dst) // a killed encode leaves an unplayable file
			return nil, fmt.Errorf("encoding %dp: %w", r.Height, err)
		}

		info, err := os.Stat(dst)
		if err != nil {
			return nil, fmt.Errorf("stat %dp output: %w", r.Height, err)
		}

		if err := store.SaveRendition(ctx, w.Pool, id, r, dst, info.Size()); err != nil {
			return nil, err
		}

		produced = append(produced, packager.Input{Path: dst, Height: r.Height})

		slog.Info("rendition encoded",
			"asset_id", id, "height", r.Height,
			"bytes", info.Size(), "path", dst)
	}
	return produced, nil
}

// encodeAudio produces the single audio track shared by every rung. Returns
// an empty path when the source has no audio at all — a legitimate case
// (silent footage), not a failure.
func (w *TranscodeWorker) encodeAudio(ctx context.Context, id, srcPath string, track ladder.AudioTrack) (string, error) {
	dst := filepath.Join(renditionDir(id), "audio.m4a")

	encodeCtx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()

	if err := transcode.RunAudio(encodeCtx, srcPath, track, dst); err != nil {
		os.Remove(dst)
		return "", err
	}

	info, err := os.Stat(dst)
	if err != nil {
		return "", fmt.Errorf("stat audio output: %w", err)
	}

	if err := store.SaveAudioTrack(ctx, w.Pool, id, dst, track.BitrateKbps); err != nil {
		return "", err
	}

	slog.Info("audio encoded", "asset_id", id,
		"bitrate_kbps", track.BitrateKbps, "bytes", info.Size(), "path", dst)
	return dst, nil
}

func (w *TranscodeWorker) packageAsset(ctx context.Context, id string, video []packager.Input, audioPath string) (string, string, error) {
	outDir := filepath.Join("storage", "packaged", id)

	packCtx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()

	if err := packager.Run(packCtx, video, audioPath, outDir, ladder.SegmentSeconds); err != nil {
		return "", "", err
	}

	hls, dash := packager.ManifestPaths(outDir)
	return hls, dash, nil
}

// Timeout disables River's per-job deadline for transcode jobs. River's
// default is 60s; a 1080p encode of a 10-minute source takes minutes, so the
// default was killing FFmpeg mid-write and leaving MP4s with no moov atom.
// Each encode bounds itself with its own context in encodeRungs.
func (w *TranscodeWorker) Timeout(*river.Job[jobs.TranscodeArgs]) time.Duration {
	return -1
}
