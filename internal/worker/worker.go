package worker

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/MmedaraJ/fastforge/internal/contentkey"
	"github.com/MmedaraJ/fastforge/internal/jobs"
	"github.com/MmedaraJ/fastforge/internal/ladder"
	"github.com/MmedaraJ/fastforge/internal/langs"
	"github.com/MmedaraJ/fastforge/internal/packager"
	"github.com/MmedaraJ/fastforge/internal/probe"
	"github.com/MmedaraJ/fastforge/internal/storage"
	"github.com/MmedaraJ/fastforge/internal/store"
	"github.com/MmedaraJ/fastforge/internal/transcode"
	"github.com/MmedaraJ/fastforge/internal/vmaf"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
)

type TranscodeWorker struct {
	river.WorkerDefaults[jobs.TranscodeArgs]
	Pool     *pgxpool.Pool
	Uploader storage.Uploader
	// DRM is DRM_MODE: packager.ModeClearKey, packager.ModeWidevineTest, or
	// "" to package clear.
	DRM string
	// Keys wraps content keys. Set whenever DRM is ModeClearKey.
	Keys *contentkey.Wrapper
}

// clearLeadSeconds leaves the start of every asset unencrypted, so the first
// frame needn't wait for the licence. 0 encrypts everything; Step 7 measures
// what that costs.
const clearLeadSeconds = 0

// packagedDir is the single definition of where an asset's packaged output
// goes, matching renditionDir.
func packagedDir(id string) string {
	return filepath.Join("storage", "packaged", id)
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

	audio, defaultLanguage, audioTracks, err := w.encodeAudioTracks(ctx, id, storagePath, src)
	if err != nil {
		return err
	}
	subtitles, subtitleTracks, err := findSubtitles(id)
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
	encryption, err := w.encryption(ctx, id)
	if err != nil {
		return err
	}
	hlsPath, dashPath, err := w.packageAsset(ctx, id, packager.Job{
		Video:           produced,
		Audio:           audio,
		Subtitles:       subtitles,
		DefaultLanguage: defaultLanguage,
		Encryption:      encryption,
	})
	if err != nil {
		return err
	}
	if err := store.SavePackaging(ctx, w.Pool, id, hlsPath, dashPath, w.DRM); err != nil {
		return err
	}
	// Recorded only now: these are the tracks the manifests actually offer.
	if err := store.SaveTracks(ctx, w.Pool, id, append(audioTracks, subtitleTracks...)); err != nil {
		return err
	}
	slog.Info("packaged", "asset_id", id, "hls", hlsPath, "dash", dashPath)

	if err := store.SetProgressStage(ctx, w.Pool, id, "publishing"); err != nil {
		return err
	}
	// Deliberately NOT tagged badMedia. A failed upload is credentials, a
	// network, or Cloudflare having a bad minute — never the asset's fault —
	// so Work routes it back to the queue. Retrying is safe because writing
	// the same key twice is idempotent: the second attempt simply overwrites
	// whatever the first one managed to put there.
	if err := w.Uploader.Upload(ctx, packagedDir(id), "packaged/"+id); err != nil {
		return fmt.Errorf("publishing: %w", err)
	}
	slog.Info("published", "asset_id", id)
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

// encodeAudioTracks encodes every audio stream in the source, one per
// language, each shared by every rung. It returns them ready for packaging,
// the default language, and their rows for the tracks table. A silent source
// returns none, which the packager treats as "video only" rather than as an
// error.
//
// Audio runs before video because it takes seconds: a source with broken audio
// fails before we spend minutes encoding pictures we're going to throw away.
func (w *TranscodeWorker) encodeAudioTracks(ctx context.Context, id, storagePath string, src probe.Result) ([]packager.Audio, string, []store.Track, error) {
	if len(src.AudioStreams) == 0 {
		slog.Info("source has no audio stream; packaging video only", "asset_id", id)
		return nil, "", nil, nil
	}

	// The default is the stream the file marks as default, else the first.
	def := 0
	for i, s := range src.AudioStreams {
		if s.Default {
			def = i
			break
		}
	}

	settings := ladder.BuildAudioTrack(ladder.DefaultLadder)
	audio := make([]packager.Audio, 0, len(src.AudioStreams))
	tracks := make([]store.Track, 0, len(src.AudioStreams))
	for i, s := range src.AudioStreams {
		path, err := w.encodeAudio(ctx, id, storagePath, s.Index, settings, i == def)
		if err != nil {
			return nil, "", nil, err
		}
		language := langs.Normalize(s.Language)
		label := langs.Label(s.Language, s.Title)
		audio = append(audio, packager.Audio{Path: path, Language: language, Label: label})
		tracks = append(tracks, store.Track{Kind: "audio", Language: language, Label: label, IsDefault: i == def, Path: path})
	}

	// An untagged default is still the default: the packager writes "und"
	// for it, and matching "und" here marks it DEFAULT=YES.
	defaultLanguage := langs.Normalize(src.AudioStreams[def].Language)
	if defaultLanguage == "" {
		defaultLanguage = "und"
	}
	return audio, defaultLanguage, tracks, nil
}

// findSubtitles lists the WebVTT files uploaded with the asset: one per
// language, named <language>.vtt by the API. Most assets have none.
func findSubtitles(id string) ([]packager.Subtitles, []store.Track, error) {
	dir := storage.SubtitlesDir(id)
	entries, err := os.ReadDir(dir) // sorted by name, so the order is stable
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil, nil
	}
	if err != nil {
		// Untagged: an unreadable directory is our problem, not the asset's.
		return nil, nil, fmt.Errorf("listing subtitles: %w", err)
	}

	var subtitles []packager.Subtitles
	var tracks []store.Track
	for _, e := range entries {
		language, ok := strings.CutSuffix(e.Name(), ".vtt")
		if e.IsDir() || !ok {
			continue
		}
		path := filepath.Join(dir, e.Name())
		label := langs.Label(language, "")
		subtitles = append(subtitles, packager.Subtitles{Path: path, Language: language, Label: label})
		tracks = append(tracks, store.Track{Kind: "subtitles", Language: language, Label: label, Path: path})
	}
	return subtitles, tracks, nil
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

// encodeAudio produces one audio language from the source's audio stream
// number `stream`, shared by every rung. The default language is also
// recorded on the asset itself, as before there were several.
func (w *TranscodeWorker) encodeAudio(ctx context.Context, id, srcPath string, stream int, track ladder.AudioTrack, isDefault bool) (string, error) {
	dst := filepath.Join(renditionDir(id), fmt.Sprintf("audio_%d.m4a", stream))

	encodeCtx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()

	if err := transcode.RunAudio(encodeCtx, srcPath, stream, track, dst); err != nil {
		os.Remove(dst)
		return "", badMedia(err)
	}

	info, err := os.Stat(dst)
	if err != nil {
		return "", fmt.Errorf("stat audio output: %w", err)
	}

	if isDefault {
		if err := store.SaveAudioTrack(ctx, w.Pool, id, dst, track.BitrateKbps); err != nil {
			return "", err
		}
	}

	slog.Info("audio encoded", "asset_id", id, "stream", stream,
		"bitrate_kbps", track.BitrateKbps, "bytes", info.Size(), "path", dst)
	return dst, nil
}

// encryption decides how this asset is encrypted, fetching or making its
// content key first. Nil for a clear asset.
func (w *TranscodeWorker) encryption(ctx context.Context, id string) (*packager.Encryption, error) {
	switch w.DRM {
	case "":
		return nil, nil
	case packager.ModeWidevineTest:
		return &packager.Encryption{Mode: w.DRM, ContentID: id, ClearLeadSeconds: clearLeadSeconds}, nil
	}

	// Clear Key: one key per asset, made on the first attempt and kept. A
	// retry that made a new key would leave anything already uploaded under
	// the old one.
	key := contentkey.New()
	keyID, wrapped, err := store.SaveContentKey(ctx, w.Pool, id, key.ID, w.Keys.Wrap(id, key))
	if err != nil {
		return nil, err
	}
	// Unwrapping what's stored, rather than using the key just made, is
	// what makes a retry reuse the first attempt's key.
	key, err = w.Keys.Unwrap(id, keyID, wrapped)
	if err != nil {
		return nil, err
	}
	// The key ID is public, so it may be logged. The key, never.
	slog.Info("content key ready", "asset_id", id, "key_id", fmt.Sprintf("%x", key.ID))
	return &packager.Encryption{Mode: w.DRM, KeyID: key.ID, Key: key.Value, ClearLeadSeconds: clearLeadSeconds}, nil
}

// packageAsset fills in where the output goes and how long segments are,
// and runs the packager.
func (w *TranscodeWorker) packageAsset(ctx context.Context, id string, job packager.Job) (string, string, error) {
	job.OutDir = packagedDir(id)
	job.SegmentSeconds = ladder.SegmentSeconds

	packCtx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()

	if err := packager.Run(packCtx, job); err != nil {
		return "", "", badMedia(err)
	}

	hls, dash := packager.ManifestPaths(job.OutDir)
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
			// Untagged: scoring can fail because the report was unreadable or
			// libvmaf's JSON schema didn't match what we parse. Neither is the
			// asset's fault, and permanently failing a good encode over a
			// transient read is worse than scoring it twice.
			return fmt.Errorf("scoring %dp: %w", in.Height, err)
		}

		if err := store.SaveVMAF(ctx, w.Pool, id, in.Height, score.Mean); err != nil {
			return err
		}

		slog.Info("quality scored", "asset_id", id, "height", in.Height,
			"vmaf", score.Mean, "harmonic", score.HarmonicMean, "min", score.Min)

		// Still tagged: the gate is a judgement about the media itself, and
		// rescoring the same bytes produces the same number.
		if in.Height == top && score.HarmonicMean < vmaf.TopRungFloor {
			return badMedia(fmt.Errorf("quality gate: %dp scored %.2f, floor is %.1f",
				in.Height, score.HarmonicMean, vmaf.TopRungFloor))
		}
	}
	return nil
}
