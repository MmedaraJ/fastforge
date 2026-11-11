package packager

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

// Manifest filenames, in one place so Args and the worker cannot disagree
// about where the packager wrote them.
const (
	HLSManifest  = "master.m3u8"
	DASHManifest = "manifest.mpd"
)

// Input is one encoded rendition on disk, waiting to be packaged.
// The packager needs the path to read it and the height to name its
// segment folder and playlist.
type Input struct {
	Path   string
	Height int
}

// Audio is one audio language, encoded and waiting to be packaged.
type Audio struct {
	Path string
	// Language is a BCP 47 tag ("en", "vi") or an ISO 639-2 one ("eng",
	// "vie"), which is what video files carry. The packager writes the
	// shortest form into both manifests either way: "eng" becomes "en".
	Language string
	// Label is the menu name: HLS's NAME (the hls_name field) and DASH's
	// <Label> (dash_label). Without a <Label>, DASH players show the tag.
	Label string
}

// Subtitles is one subtitle language: a WebVTT file covering the whole asset.
type Subtitles struct {
	Path     string
	Language string
	Label    string
}

// Job is everything one packaging run needs.
type Job struct {
	Video     []Input
	Audio     []Audio
	Subtitles []Subtitles
	// DefaultLanguage is the audio language players start with: DEFAULT=YES
	// in HLS, Role "main" in DASH. Empty marks none.
	DefaultLanguage string
	OutDir          string
	SegmentSeconds  int
}

// Args builds the Shaka Packager argument list. Pure: no exec, no filesystem,
// so a table test can assert every descriptor.
//
// Each input contributes a "stream descriptor" — a comma-separated key=value
// string saying what to read and where to write it. One per video rendition,
// one per audio language, one per subtitle language.
func Args(j Job) []string {
	args := make([]string, 0, len(j.Video)+len(j.Audio)+len(j.Subtitles)+12)

	for _, in := range j.Video {
		dir := fmt.Sprintf("%dp", in.Height)
		args = append(args, strings.Join([]string{
			"in=" + in.Path,
			"stream=video",
			"init_segment=" + filepath.Join(j.OutDir, dir, "init.mp4"),
			"segment_template=" + filepath.Join(j.OutDir, dir, "$Number$.m4s"),
			"playlist_name=" + filepath.Join(dir, "index.m3u8"),
		}, ","))
	}

	// Every audio language in ONE group, "audio". Every video variant in the
	// HLS master points at that group, so any rung plays with any language,
	// and each language is segmented once and cached once.
	audioDirs := trackDirs(len(j.Audio), func(i int) string { return j.Audio[i].Language })
	for i, a := range j.Audio {
		dir := filepath.Join("audio", audioDirs[i])
		args = append(args, strings.Join([]string{
			"in=" + a.Path,
			"stream=audio",
			"language=" + orUnd(a.Language),
			"init_segment=" + filepath.Join(j.OutDir, dir, "init.mp4"),
			"segment_template=" + filepath.Join(j.OutDir, dir, "$Number$.m4s"),
			"playlist_name=" + filepath.Join(dir, "index.m3u8"),
			"hls_group_id=audio",
			"hls_name=" + descriptorSafe(a.Label),
			// The same name for DASH. packager --help doesn't list this
			// field, but v3.9.3 reads it (app/stream_descriptor.cc) and
			// writes it as the AdaptationSet's <Label>.
			"dash_label=" + descriptorSafe(a.Label),
		}, ","))
	}

	// Subtitles: the WebVTT file cut into one text file per segment, listed
	// by a subtitle playlist for HLS and a SegmentTemplate for DASH. Both
	// manifests point at the same .vtt files.
	textDirs := trackDirs(len(j.Subtitles), func(i int) string { return j.Subtitles[i].Language })
	for i, s := range j.Subtitles {
		dir := filepath.Join("text", textDirs[i])
		args = append(args, strings.Join([]string{
			"in=" + s.Path,
			"stream=text",
			"language=" + orUnd(s.Language),
			"segment_template=" + filepath.Join(j.OutDir, dir, "$Number$.vtt"),
			"playlist_name=" + filepath.Join(dir, "index.m3u8"),
			"hls_group_id=subs",
			"hls_name=" + descriptorSafe(s.Label),
			"dash_label=" + descriptorSafe(s.Label),
		}, ","))
	}

	args = append(args,
		"--segment_duration", strconv.Itoa(j.SegmentSeconds),
		// Segment templates are DASH's live profile, so without this flag
		// Shaka Packager writes a live MPD (type="dynamic"). DASH players then
		// treat the asset as live and start near the live edge: the end of
		// the clip. HLS is unaffected; its playlists already say VOD.
		"--generate_static_live_mpd",
		"--mpd_output", filepath.Join(j.OutDir, DASHManifest),
		"--hls_master_playlist_output", filepath.Join(j.OutDir, HLSManifest),
	)

	if j.DefaultLanguage != "" {
		args = append(args,
			"--default_language", j.DefaultLanguage,
			// --default_language marks subtitles in that language as
			// DEFAULT=YES too, and DEFAULT=YES subtitles are ones a player
			// should show without being asked (RFC 8216, 4.3.4.1): hls.js
			// does. "zxx" is BCP 47 for "no linguistic content", which no
			// subtitle track is tagged with, so no subtitles are default.
			"--default_text_language", "zxx",
		)
	}
	return args
}

// trackDirs names each track's folder after its language: "en", "vi". Two
// tracks in one language (a commentary beside the main English, say) would
// share a folder, so the second becomes "en-2".
func trackDirs(n int, language func(int) string) []string {
	dirs := make([]string, n)
	seen := map[string]int{}
	for i := range n {
		lang := orUnd(language(i))
		seen[lang]++
		dirs[i] = lang
		if seen[lang] > 1 {
			dirs[i] = fmt.Sprintf("%s-%d", lang, seen[lang])
		}
	}
	return dirs
}

// orUnd fills in "und", BCP 47 for "undetermined": Apple's HLS spec wants a
// LANGUAGE on every audio and subtitle rendition (item 8.10).
func orUnd(language string) string {
	if language == "" {
		return "und"
	}
	return language
}

// descriptorSafe keeps a label from breaking its stream descriptor, whose
// fields are separated by commas with no way to escape one.
func descriptorSafe(label string) string {
	return strings.ReplaceAll(label, ",", " ")
}

// ManifestPaths returns where Run will have written the two manifests.
func ManifestPaths(outDir string) (hls, dash string) {
	return filepath.Join(outDir, HLSManifest), filepath.Join(outDir, DASHManifest)
}

// Run packages the job into j.OutDir. Cancellation comes from ctx.
func Run(ctx context.Context, j Job) error {
	if len(j.Video) == 0 {
		return fmt.Errorf("packaging: no renditions to package")
	}

	dirs := []string{j.OutDir}
	for _, in := range j.Video {
		dirs = append(dirs, filepath.Join(j.OutDir, fmt.Sprintf("%dp", in.Height)))
	}
	for _, d := range trackDirs(len(j.Audio), func(i int) string { return j.Audio[i].Language }) {
		dirs = append(dirs, filepath.Join(j.OutDir, "audio", d))
	}
	for _, d := range trackDirs(len(j.Subtitles), func(i int) string { return j.Subtitles[i].Language }) {
		dirs = append(dirs, filepath.Join(j.OutDir, "text", d))
	}
	for _, d := range dirs {
		if err := os.MkdirAll(d, 0o755); err != nil {
			return fmt.Errorf("packaging: creating %s: %w", d, err)
		}
	}

	// Note what is NOT here: quoting. $Number$ needed single quotes in bash;
	// as argv it is just a string.
	cmd := exec.CommandContext(ctx, "packager", Args(j)...)

	var stderr strings.Builder
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		tail := stderr.String()
		if len(tail) > 2000 {
			tail = tail[len(tail)-2000:]
		}
		return fmt.Errorf("shaka packager: %w: %s", err, tail)
	}
	return nil
}
