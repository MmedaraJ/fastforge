package transcode

import (
	"testing"

	"github.com/MmedaraJ/fastforge/internal/ladder"
)

// argValue returns the argument that follows flag.
func argValue(args []string, flag string) (string, bool) {
	for i, a := range args {
		if a == flag && i+1 < len(args) {
			return args[i+1], true
		}
	}
	return "", false
}

func TestArgs(t *testing.T) {
	rung := ladder.Rung{
		VideoCodec: "h264", AudioCodec: "aac",
		Width: 1280, Height: 720,
		GOP: 48, FPS: 24,
		BitrateKbps: 2800, MaxrateKbps: 2996, BufsizeKbps: 4200,
		AudioBitrateKbps: 128,
	}
	args := Args("storage/sources/x.mov", rung, "storage/renditions/x/720p.mp4")

	t.Run("every value comes from the rung", func(t *testing.T) {
		want := map[string]string{
			"-i":       "storage/sources/x.mov",
			"-b:v":     "2800k",
			"-maxrate": "2996k",
			"-bufsize": "4200k",
			"-vf":      "scale=1280:720",
			"-g":       "48",
			"-r":       "24",
			"-b:a":     "128k",
			"-c:v":     "libx264",
			"-c:a":     "aac",
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

	// The reason this test exists. These three flags together are what keeps
	// segment boundaries aligned across renditions; break any of them and ABR
	// switching glitches in ways no other test would catch.
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
