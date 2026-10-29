package transcode

import (
	"context"
	"fmt"
	"os/exec"
	"strconv"
	"strings"

	"github.com/MmedaraJ/fastforge/internal/ladder"
)

// Args builds the FFmpeg argument list for one rung. Pure: no exec, no
// filesystem — so a table test can assert every flag.
func Args(srcPath string, r ladder.Rung, dstPath string) []string {
	return []string{
		"-nostdin", // never block waiting for terminal input
		"-y",       // overwrite dst (idempotent re-runs)
		"-i", srcPath,

		// video: capped VBV encode — the streaming contract, not CRF
		"-c:v", "libx264",
		"-profile:v", "high",
		"-preset", "medium",
		"-b:v", kbps(r.BitrateKbps),
		"-maxrate", kbps(r.MaxrateKbps),
		"-bufsize", kbps(r.BufsizeKbps),
		"-vf", fmt.Sprintf("scale=%d:%d", r.Width, r.Height),

		// keyframe discipline: fixed GOP, no scene-cut keyframes, forced fps —
		// this is what makes segments align across renditions later
		"-g", strconv.Itoa(r.GOP),
		"-keyint_min", strconv.Itoa(r.GOP),
		"-sc_threshold", "0",
		"-r", strconv.Itoa(r.FPS),

		// audio
		"-c:a", "aac",
		"-b:a", kbps(r.AudioBitrateKbps),

		"-movflags", "+faststart",
		dstPath,
	}
}

func kbps(v int) string { return strconv.Itoa(v) + "k" }

// Run executes one rung's encode. Cancellation/timeout comes from ctx.
func Run(ctx context.Context, srcPath string, r ladder.Rung, dstPath string) error {
	args := Args(srcPath, r, dstPath)
	cmd := exec.CommandContext(ctx, "ffmpeg", args...)

	// FFmpeg writes everything human-readable to stderr. Capture it so a
	// failure carries the actual reason instead of just "exit status 1".
	var stderr strings.Builder
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		tail := stderr.String()
		if len(tail) > 2000 { // keep the last chunk: the error lives at the end
			tail = tail[len(tail)-2000:]
		}
		return fmt.Errorf("ffmpeg %dp: %w: %s", r.Height, err, tail)
	}
	return nil
}
