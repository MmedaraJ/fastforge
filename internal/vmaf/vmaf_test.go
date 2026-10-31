package vmaf

import (
	"strings"
	"testing"
)

func TestArgs(t *testing.T) {
	args := Args("storage/renditions/x/480p.mp4", "storage/sources/x.mov", 1920, 1080, "out.json", 4)

	joined := strings.Join(args, " ")

	// The invariant this file exists for. libvmaf reads [distorted][reference];
	// reversed, it produces a confident, meaningless number that no other test
	// here would catch.
	t.Run("distorted input comes first", func(t *testing.T) {
		dist := strings.Index(joined, "480p.mp4")
		ref := strings.Index(joined, "x.mov")
		if dist == -1 || ref == -1 {
			t.Fatalf("both inputs should appear: %q", joined)
		}
		if dist > ref {
			t.Error("distorted must be input 0 and reference input 1")
		}
	})

	t.Run("distorted is scaled to the reference size", func(t *testing.T) {
		if !strings.Contains(joined, "scale=1920:1080") {
			t.Errorf("want scale to reference dimensions, got %q", joined)
		}
	})

	t.Run("writes a json report", func(t *testing.T) {
		if !strings.Contains(joined, "log_fmt=json") {
			t.Error("report must be json; the text format is not machine-readable")
		}
		if !strings.Contains(joined, "log_path=out.json") {
			t.Error("log_path missing")
		}
	})

	t.Run("encodes nothing", func(t *testing.T) {
		if !strings.Contains(joined, "-f null") {
			t.Error("measurement must null-mux, not write an output file")
		}
	})
}

func TestLogPath(t *testing.T) {
	got := LogPath("storage/renditions/x/720p.mp4")
	want := "storage/renditions/x/720p.vmaf.json"
	if got != want {
		t.Errorf("LogPath = %q, want %q", got, want)
	}
}
