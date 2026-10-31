// Package vmaf scores an encoded rendition against the source it came from.
//
// VMAF (Video Multi-method Assessment Fusion) is a full-reference metric: it
// needs both the distorted video and the original. Unlike PSNR or SSIM, which
// do pixel arithmetic, VMAF was trained against subjective ratings, so a score
// of 93 means something about what a person would say rather than about the
// numerical distance between two frames. Netflix published it and the industry
// standardized on it; "what's your VMAF?" is now a normal question in an
// encoding interview.
package vmaf

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/MmedaraJ/fastforge/internal/transcode"
)

// TopRungFloor is the score the highest rendition must clear.
//
// Deliberately low. This gate exists to catch encodes that are BROKEN — wrong
// source, truncated file, a scale filter that silently did nothing — not
// encodes that are merely mediocre. A broken encode scores in the 20s and 30s;
// a grainy or high-motion source honestly encoded can sit in the low 80s and
// is fine. A floor of 70 fails the first and never the second. Raise it and
// you start rejecting legitimate content, which is how quality gates get
// switched off permanently in real systems.
const TopRungFloor = 70.0

// Score is the pooled result for one rendition.
type Score struct {
	Mean         float64
	HarmonicMean float64
	Min          float64
}

// report mirrors the JSON libvmaf writes. The per-frame array is large and
// deliberately not decoded — encoding/json skips fields the struct omits, so
// this costs nothing even on a long asset.
type report struct {
	PooledMetrics struct {
		VMAF struct {
			Mean         float64 `json:"mean"`
			HarmonicMean float64 `json:"harmonic_mean"`
			Min          float64 `json:"min"`
		} `json:"vmaf"`
	} `json:"pooled_metrics"`
}

// Args builds the FFmpeg invocation that scores distPath against refPath.
//
// Two things here are load-bearing.
//
// First, the inputs must be the same size before libvmaf sees them, so the
// rendition is scaled back up to the source's dimensions. That upscale is part
// of the measurement rather than a workaround: it is exactly what a viewer's
// screen does with a 480p stream on a 1080p display, and it is why a lower
// rung legitimately scores lower.
//
// Second, the order is [distorted][reference], not the reverse. Swap them and
// libvmaf still runs, still writes a log, and reports a number that looks
// plausible and means nothing. This is the single most common way to get VMAF
// wrong, which is why the test below pins it.
func Args(distPath, refPath string, refWidth, refHeight int, logPath string, threads int) []string {
	filter := fmt.Sprintf(
		"[0:v]scale=%d:%d:flags=bicubic,setpts=PTS-STARTPTS[dist];"+
			"[1:v]setpts=PTS-STARTPTS[ref];"+
			"[dist][ref]libvmaf=log_fmt=json:log_path=%s:n_threads=%d",
		refWidth, refHeight, logPath, threads,
	)
	return []string{
		"-nostdin",
		"-i", distPath,
		"-i", refPath,
		"-lavfi", filter,
		// There is no output file. VMAF's product is the log; the decoded
		// frames are thrown away, so we null-mux them rather than encode
		// anything.
		"-f", "null",
		"-",
	}
}

// LogPath is where the JSON report for a rendition lives: next to the
// rendition itself, kept rather than deleted. The per-frame data in it is what
// you'd graph to find the worst few seconds of an encode.
func LogPath(distPath string) string {
	return strings.TrimSuffix(distPath, filepath.Ext(distPath)) + ".vmaf.json"
}

// Run scores one rendition against the source and returns the pooled result.
func Run(ctx context.Context, distPath, refPath string, refWidth, refHeight int) (Score, error) {
	logPath := LogPath(distPath)

	args := Args(distPath, refPath, refWidth, refHeight, logPath, runtime.NumCPU())
	if err := transcode.Run(ctx, args, "vmaf "+filepath.Base(distPath)); err != nil {
		return Score{}, err
	}

	raw, err := os.ReadFile(logPath)
	if err != nil {
		return Score{}, fmt.Errorf("vmaf: reading report: %w", err)
	}

	var r report
	if err := json.Unmarshal(raw, &r); err != nil {
		return Score{}, fmt.Errorf("vmaf: parsing report: %w", err)
	}

	s := Score{
		Mean:         r.PooledMetrics.VMAF.Mean,
		HarmonicMean: r.PooledMetrics.VMAF.HarmonicMean,
		Min:          r.PooledMetrics.VMAF.Min,
	}

	// A zero mean means the JSON parsed but carried nothing we recognise —
	// usually an libvmaf version whose schema differs. Fail loudly rather than
	// recording 0.0 as if it were a measurement.
	if s.Mean == 0 {
		return Score{}, fmt.Errorf("vmaf: no pooled score in %s", logPath)
	}
	return s, nil
}
