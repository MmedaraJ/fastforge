package packager

import (
	"slices"
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
	job := Job{
		Video: inputs,
		Audio: []Audio{
			{Path: "storage/renditions/x/audio_0.m4a", Language: "eng", Label: "English"},
			{Path: "storage/renditions/x/audio_1.m4a", Language: "vie", Label: "Tiếng Việt"},
		},
		Subtitles: []Subtitles{
			{Path: "storage/subtitles/x/en.vtt", Language: "en", Label: "English"},
		},
		DefaultLanguage: "eng",
		OutDir:          out,
		SegmentSeconds:  6,
	}
	args := Args(job)

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

	t.Run("one audio descriptor per language, all in one group", func(t *testing.T) {
		for _, a := range job.Audio {
			d, ok := descriptorFor(args, a.Path)
			if !ok {
				t.Fatalf("no descriptor references %s", a.Path)
			}
			for _, want := range []string{"stream=audio", "language=" + a.Language, "hls_name=" + a.Label, "dash_label=" + a.Label, "hls_group_id=audio"} {
				if !strings.Contains(d, want) {
					t.Errorf("%s: missing %q in %q", a.Path, want, d)
				}
			}
		}
	})

	t.Run("each language gets its own folder", func(t *testing.T) {
		en, _ := descriptorFor(args, "audio_0.m4a")
		vi, _ := descriptorFor(args, "audio_1.m4a")
		if !strings.Contains(en, "audio/eng/") || !strings.Contains(vi, "audio/vie/") {
			t.Errorf("want audio/eng/ and audio/vie/, got %q and %q", en, vi)
		}
	})

	t.Run("subtitles are cut into WebVTT segments", func(t *testing.T) {
		d, ok := descriptorFor(args, "en.vtt")
		if !ok {
			t.Fatal("no subtitle descriptor")
		}
		for _, want := range []string{"stream=text", "language=en", "text/en/$Number$.vtt", "hls_group_id=subs", "hls_name=English", "dash_label=English"} {
			if !strings.Contains(d, want) {
				t.Errorf("missing %q in %q", want, d)
			}
		}
	})

	t.Run("the default language is audio only", func(t *testing.T) {
		if got, _ := flagValue(args, "--default_language"); got != "eng" {
			t.Errorf("--default_language = %q, want \"eng\"", got)
		}
		if got, _ := flagValue(args, "--default_text_language"); got != "zxx" {
			t.Errorf("--default_text_language = %q, want \"zxx\" so no subtitles are DEFAULT=YES", got)
		}
	})

	t.Run("two tracks in one language don't share a folder", func(t *testing.T) {
		a := Args(Job{Video: inputs, Audio: []Audio{
			{Path: "main.m4a", Language: "en"},
			{Path: "commentary.m4a", Language: "en"},
		}, OutDir: out, SegmentSeconds: 6})
		main, _ := descriptorFor(a, "main.m4a")
		commentary, _ := descriptorFor(a, "commentary.m4a")
		if !strings.Contains(main, "audio/en/") || !strings.Contains(commentary, "audio/en-2/") {
			t.Errorf("want audio/en/ and audio/en-2/, got %q and %q", main, commentary)
		}
	})

	t.Run("an untagged track is undetermined, and a comma can't split a label", func(t *testing.T) {
		a := Args(Job{Video: inputs, Audio: []Audio{{Path: "a.m4a", Label: "Director, commentary"}}, OutDir: out, SegmentSeconds: 6})
		d, _ := descriptorFor(a, "a.m4a")
		if !strings.Contains(d, "language=und") {
			t.Errorf("want language=und, got %q", d)
		}
		if !strings.Contains(d, "hls_name=Director  commentary") || !strings.Contains(d, "dash_label=Director  commentary") {
			t.Errorf("the comma should be gone from the label, got %q", d)
		}
		if _, ok := flagValue(a, "--default_language"); ok {
			t.Error("no DefaultLanguage means no --default_language")
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

	t.Run("the DASH manifest is static (VOD), not live", func(t *testing.T) {
		if !slices.Contains(args, "--generate_static_live_mpd") {
			t.Error("--generate_static_live_mpd missing: the packager would write a live MPD")
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
		a := Args(Job{OutDir: out, SegmentSeconds: 6})
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
		a := Args(Job{Video: inputs, OutDir: out, SegmentSeconds: 6})
		for _, x := range a {
			if strings.Contains(x, "stream=audio") {
				t.Error("no audio tracks must not produce an audio descriptor")
			}
		}
	})
}
