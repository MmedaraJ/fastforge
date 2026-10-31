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
	"github.com/MmedaraJ/fastforge/internal/vmaf"
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
		return nil
	}
	if err != nil {
		return fmt.Errorf("asset %s: %w", id, err)
	}
	slog.Info("asset claimed", "asset_id", id, "attempt", job.Attempt)

	// One classification for the whole pipeline. Adding a stage no longer
	// means re-deciding the retry policy.
	if err := w.process(ctx, id, storagePath); err != nil {
		// A cancelled parent ctx means shutdown or SIGTERM, not bad media.
		// Without this, Ctrl-C mid-encode permanently fails whatever was in
		// flight — the same class of mistake as the River 60s timeout.
		if ctx.Err() != nil {
			return fmt.Errorf("asset %s: interrupted: %w", id, err)
		}
		if errors.Is(err, ErrBadMedia) {
			return w.fail(ctx, id, job.Attempt, err)
		}
		return w.transitionErr(id, job.Attempt, err)
	}

	if err := store.MarkReady(ctx, w.Pool, id); err != nil {
		return w.transitionErr(id, job.Attempt, err)
	}
	slog.Info("asset ready", "asset_id", id, "attempt", job.Attempt)
	return nil
}

// process runs every stage for a claimed asset. Failures caused by the media
// are tagged with badMedia; everything else is infrastructure and retryable.
func (w *TranscodeWorker) process(ctx context.Context, id, storagePath string) error {
	src, rungs, err := w.inspect(ctx, id, storagePath)
	if err != nil {
		return err
	}

	// Both the audio track and every video rung land here. Create it once, up
	// front. Before audio moved ahead of video this happened as a side effect
	// inside encodeRungs — an undeclared dependency that broke the moment the
	// two calls were reordered.
	//
	// Not tagged: a disk that is full or unwritable is our problem, not the
	// asset's, and should be retried rather than permanently failing it.
	if err := os.MkdirAll(renditionDir(id), 0o755); err != nil {
		return fmt.Errorf("creating rendition dir: %w", err)
	}

	audioPath, err := w.encodeAudioIfPresent(ctx, id, storagePath, src)
	if err != nil {
		return err
	}

	produced, err := w.encodeRungs(ctx, id, storagePath, rungs)
	if err != nil {
		return err
	}

	if err := store.SetProgressStage(ctx, w.Pool, id, "measuring"); err != nil {
		return err
	}
	if err := w.measureQuality(ctx, id, storagePath, src, produced); err != nil {
		return err
	}

	if err := store.SetProgressStage(ctx, w.Pool, id, "packaging"); err != nil {
		return err
	}
	hlsPath, dashPath, err := w.packageAsset(ctx, id, produced, audioPath)
	if err != nil {
		return err
	}
	if err := store.SavePackaging(ctx, w.Pool, id, hlsPath, dashPath); err != nil {
		return err
	}
	slog.Info("packaged", "asset_id", id, "hls", hlsPath, "dash", dashPath)
	return nil
}

// inspect probes the source and derives the ladder from it. Both failures are
// the asset's fault: unreadable media, or a source the ladder cannot serve.
func (w *TranscodeWorker) inspect(ctx context.Context, id, storagePath string) (probe.Result, []ladder.Rung, error) {
	src, err := probe.Probe(ctx, storagePath)
	if err != nil {
		return probe.Result{}, nil, badMedia(err)
	}
	if err := store.SaveProbeResult(ctx, w.Pool, id, src); err != nil {
		return probe.Result{}, nil, err
	}
	slog.Info("probed", "asset_id", id, "width", src.Width, "height", src.Height,
		"fps", src.FPS, "duration_s", src.DurationS)

	rungs, err := ladder.BuildLadder(src, ladder.DefaultLadder, ladder.SegmentSeconds)
	if err != nil {
		return probe.Result{}, nil, badMedia(err)
	}
	slog.Info("ladder built", "asset_id", id, "rungs", len(rungs))
	return src, rungs, nil
}

// encodeAudioIfPresent returns "" for a silent source, which the packager
// treats as "video only" rather than as an error.
//
// Audio runs before video because it takes seconds: a source with broken audio
// fails before we spend minutes encoding pictures we're going to throw away.
func (w *TranscodeWorker) encodeAudioIfPresent(ctx context.Context, id, storagePath string, src probe.Result) (string, error) {
	if src.AudioCodec == "" {
		slog.Info("source has no audio stream; packaging video only", "asset_id", id)
		return "", nil
	}
	track := ladder.BuildAudioTrack(ladder.DefaultLadder)
	path, err := w.encodeAudio(ctx, id, storagePath, track)
	if err != nil {
		return "", err
	}
	return path, nil
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

// ErrBadMedia marks a failure caused by the asset itself — unreadable source,
// a rejected encode, a failed quality gate. Retrying produces the same result,
// so Work marks the asset failed and completes the job. Everything NOT tagged
// this way is treated as infrastructure and goes back on the queue.
var ErrBadMedia = errors.New("bad media")

// badMedia tags err without flattening it. Two %w verbs (Go 1.20+) keep both
// chains intact, so errors.Is finds ErrBadMedia and the original cause alike.
func badMedia(err error) error { return fmt.Errorf("%w: %w", ErrBadMedia, err) }

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
			return nil, badMedia(fmt.Errorf("encoding %dp: %w", r.Height, err))
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
		return "", badMedia(err)
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
		return "", "", badMedia(err)
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

// measureQuality scores every rendition against the source and gates on the
// best one.
//
// It runs AFTER encoding and BEFORE packaging, deliberately: there is no point
// segmenting and writing manifests for an asset that is about to be rejected.
func (w *TranscodeWorker) measureQuality(ctx context.Context, id, srcPath string, src probe.Result, video []packager.Input) error {
	// Which rung is the top one is a property of the slice, not of its order.
	// Relying on encodeRungs returning tallest-first would make this break
	// silently the day the ladder is reordered.
	top := 0
	for _, in := range video {
		if in.Height > top {
			top = in.Height
		}
	}

	for _, in := range video {
		score, err := vmaf.Run(ctx, in.Path, srcPath, src.Width, src.Height)
		if err != nil {
			return badMedia(fmt.Errorf("scoring %dp: %w", in.Height, err))
		}

		if err := store.SaveVMAF(ctx, w.Pool, id, in.Height, score.Mean); err != nil {
			return err
		}

		slog.Info("quality scored", "asset_id", id, "height", in.Height,
			"vmaf", score.Mean, "harmonic", score.HarmonicMean, "min", score.Min)

		if in.Height == top && score.HarmonicMean < vmaf.TopRungFloor {
			return badMedia(fmt.Errorf("quality gate: %dp scored %.2f, floor is %.1f",
				in.Height, score.HarmonicMean, vmaf.TopRungFloor))
		}
	}
	return nil
}
