package transcode

import (
	"context"
	"fmt"
	"os/exec"
	"strconv"
	"strings"

	"github.com/MmedaraJ/fastforge/internal/ladder"
)

// VideoArgs builds the FFmpeg argument list for one video rendition.
//
// Video only — the audio is encoded once, separately, and shared by every
// rung. Dropping it here is what makes the ladder honest: three renditions
// used to carry three identical AAC tracks, two of which the packager threw
// away.

func VideoArgs(srcPath string, r ladder.Rung, dstPath string) []string {
	return []string{
		"-nostdin", // never block waiting for terminal input
		"-y",       // overwrite dst (idempotent re-runs)
		"-i", srcPath,

		"-an", // no audio stream in the output

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

		"-movflags", "+faststart",
		dstPath,
	}
}

func AudioArgs(srcPath string, t ladder.AudioTrack, dstPath string) []string {
	return []string{
		"-nostdin",
		"-y",
		"-i", srcPath,

		"-vn", // no video stream in the output

		"-c:a", t.Codec,
		"-b:a", kbps(t.BitrateKbps),

		// Downmix to stereo. A 5.1 source would otherwise produce a 6-channel
		// track that many browsers refuse, and every rung would inherit it.
		"-ac", "2",

		"-movflags", "+faststart",
		dstPath,
	}
}

func kbps(v int) string { return strconv.Itoa(v) + "k" }

// RunVideo encodes one video rendition.
func RunVideo(ctx context.Context, srcPath string, r ladder.Rung, dstPath string) error {
	return Run(ctx, VideoArgs(srcPath, r, dstPath), fmt.Sprintf("%dp video", r.Height))
}

// RunAudio encodes the shared audio track.
func RunAudio(ctx context.Context, srcPath string, t ladder.AudioTrack, dstPath string) error {
	return Run(ctx, AudioArgs(srcPath, t, dstPath), "audio")
}

// run execs ffmpeg and turns a failure into an error carrying its stderr.
// Both callers need identical plumbing, so it lives in one unexported place.
func Run(ctx context.Context, args []string, label string) error {
	cmd := exec.CommandContext(ctx, "ffmpeg", args...)

	// FFmpeg writes everything human-readable to stderr. Capture it so a
	// failure carries the actual reason instead of just "exit status 1".
	var stderr strings.Builder
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		tail := stderr.String()
		if len(tail) > 2000 { // the error lives at the end
			tail = tail[len(tail)-2000:]
		}
		return fmt.Errorf("ffmpeg %s: %w: %s", label, err, tail)
	}
	return nil
}
