package transcode

import (
	"testing"

	"github.com/MmedaraJ/fastforge/internal/ladder"
)

func argValue(args []string, flag string) (string, bool) {
	for i, a := range args {
		if a == flag && i+1 < len(args) {
			return args[i+1], true
		}
	}
	return "", false
}

func hasFlag(args []string, flag string) bool {
	for _, a := range args {
		if a == flag {
			return true
		}
	}
	return false
}

func TestVideoArgs(t *testing.T) {
	rung := ladder.Rung{
		VideoCodec: "h264", AudioCodec: "aac",
		Width: 1280, Height: 720,
		GOP: 48, FPS: 24,
		BitrateKbps: 2800, MaxrateKbps: 2996, BufsizeKbps: 4200,
		AudioBitrateKbps: 128,
	}
	args := VideoArgs("storage/sources/x.mov", rung, "storage/renditions/x/720p.mp4")

	t.Run("every value comes from the rung", func(t *testing.T) {
		want := map[string]string{
			"-i":       "storage/sources/x.mov",
			"-b:v":     "2800k",
			"-maxrate": "2996k",
			"-bufsize": "4200k",
			"-vf":      "scale=1280:720",
			"-g":       "48",
			"-r":       "24",
			"-c:v":     "libx264",
		}
		for flag, exp := range want {
			got, ok := argValue(args, flag)
			if !ok {
				t.Errorf("%s missing from args", flag)
				continue
			}
			if got != exp {
				t.Errorf("%s = %q, want %q", flag, got, exp)
			}
		}
	})

	// The ladder now has one shared audio track. A video rendition that
	// smuggled its own audio in would be packaged as a second audio stream
	// and quietly undo the whole point of demuxing.
	t.Run("carries no audio", func(t *testing.T) {
		if !hasFlag(args, "-an") {
			t.Error("-an missing: video renditions must not contain audio")
		}
		if _, ok := argValue(args, "-c:a"); ok {
			t.Error("-c:a present: audio is encoded separately, not per rung")
		}
		if _, ok := argValue(args, "-b:a"); ok {
			t.Error("-b:a present: audio is encoded separately, not per rung")
		}
	})

	// These three flags together keep segment boundaries aligned across
	// renditions; break any and ABR switching glitches in ways nothing else
	// here would catch.
	t.Run("keyframe discipline", func(t *testing.T) {
		g, _ := argValue(args, "-g")
		kmin, _ := argValue(args, "-keyint_min")
		sc, _ := argValue(args, "-sc_threshold")

		if g != kmin {
			t.Errorf("-g (%s) and -keyint_min (%s) must match or keyframe spacing drifts", g, kmin)
		}
		if sc != "0" {
			t.Errorf("-sc_threshold = %q, want \"0\": scene-cut keyframes misalign renditions", sc)
		}
	})

	t.Run("output path is last", func(t *testing.T) {
		if got := args[len(args)-1]; got != "storage/renditions/x/720p.mp4" {
			t.Errorf("last arg = %q, want the destination path", got)
		}
	})
}

func TestAudioArgs(t *testing.T) {
	track := ladder.AudioTrack{Codec: "aac", BitrateKbps: 128}
	args := AudioArgs("storage/sources/x.mov", track, "storage/renditions/x/audio.m4a")

	t.Run("carries no video", func(t *testing.T) {
		if !hasFlag(args, "-vn") {
			t.Error("-vn missing: the audio track must not contain video")
		}
		if _, ok := argValue(args, "-c:v"); ok {
			t.Error("-c:v present on an audio-only encode")
		}
	})

	t.Run("audio settings come from the track", func(t *testing.T) {
		if got, _ := argValue(args, "-c:a"); got != "aac" {
			t.Errorf("-c:a = %q, want \"aac\"", got)
		}
		if got, _ := argValue(args, "-b:a"); got != "128k" {
			t.Errorf("-b:a = %q, want \"128k\"", got)
		}
		if got, _ := argValue(args, "-ac"); got != "2" {
			t.Errorf("-ac = %q, want \"2\" (stereo downmix)", got)
		}
	})
}
