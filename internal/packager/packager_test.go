package packager

import (
	"strings"
	"testing"
)

func descriptorFor(args []string, substr string) (string, bool) {
	for _, a := range args {
		if strings.HasPrefix(a, "in=") && strings.Contains(a, substr) {
			return a, true
		}
	}
	return "", false
}

func flagValue(args []string, flag string) (string, bool) {
	for i, a := range args {
		if a == flag && i+1 < len(args) {
			return args[i+1], true
		}
	}
	return "", false
}

func TestArgs(t *testing.T) {
	inputs := []Input{
		{Path: "storage/renditions/x/1080p.mp4", Height: 1080},
		{Path: "storage/renditions/x/720p.mp4", Height: 720},
		{Path: "storage/renditions/x/480p.mp4", Height: 480},
	}
	out := "storage/packaged/x"
	args := Args(inputs, "storage/renditions/x/audio.m4a", out, 6)

	t.Run("one video descriptor per rendition", func(t *testing.T) {
		for _, in := range inputs {
			d, ok := descriptorFor(args, in.Path)
			if !ok {
				t.Errorf("no descriptor references %s", in.Path)
				continue
			}
			if !strings.Contains(d, "stream=video") {
				t.Errorf("%s: expected stream=video, got %q", in.Path, d)
			}
			if !strings.Contains(d, "$Number$.m4s") {
				t.Errorf("%s: missing segment template", in.Path)
			}
		}
	})

	t.Run("exactly one audio stream, from the shared track", func(t *testing.T) {
		var audio []string
		for _, a := range args {
			if strings.Contains(a, "stream=audio") {
				audio = append(audio, a)
			}
		}
		if len(audio) != 1 {
			t.Fatalf("want 1 audio descriptor, got %d: %v", len(audio), audio)
		}
		if !strings.Contains(audio[0], "audio.m4a") {
			t.Errorf("audio should come from the shared track, got %q", audio[0])
		}
		if !strings.Contains(audio[0], "hls_group_id=audio") {
			t.Errorf("audio needs an hls_group_id or the variants cannot reference it")
		}
	})

	// The invariant this file exists for. The ladder picked GOP sizes assuming
	// a particular segment duration; hand the packager a different one and
	// segments stop starting on keyframes, which breaks ABR switching in a way
	// no other test here would notice.
	t.Run("segment duration is passed through", func(t *testing.T) {
		got, ok := flagValue(args, "--segment_duration")
		if !ok {
			t.Fatal("--segment_duration missing")
		}
		if got != "6" {
			t.Errorf("--segment_duration = %q, want \"6\"", got)
		}
	})

	t.Run("both manifests are produced into outDir", func(t *testing.T) {
		hls, _ := flagValue(args, "--hls_master_playlist_output")
		dash, _ := flagValue(args, "--mpd_output")
		wantHLS, wantDASH := ManifestPaths(out)
		if hls != wantHLS {
			t.Errorf("hls output = %q, want %q", hls, wantHLS)
		}
		if dash != wantDASH {
			t.Errorf("dash output = %q, want %q", dash, wantDASH)
		}
	})

	t.Run("no inputs still produces manifest flags", func(t *testing.T) {
		a := Args(nil, "", out, 6)
		if _, ok := flagValue(a, "--mpd_output"); !ok {
			t.Error("flags should not depend on having inputs")
		}
		for _, x := range a {
			if strings.Contains(x, "stream=audio") {
				t.Error("no inputs means no audio descriptor")
			}
		}
	})

	t.Run("a source with no audio produces no audio descriptor", func(t *testing.T) {
		a := Args(inputs, "", out, 6)
		for _, x := range a {
			if strings.Contains(x, "stream=audio") {
				t.Error("empty audioPath must not produce an audio descriptor")
			}
		}
	})
}
