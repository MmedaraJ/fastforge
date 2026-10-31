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

// Args builds the Shaka Packager argument list. Pure: no exec, no filesystem,
// so a table test can assert every descriptor.
//
// Each input contributes a "stream descriptor" — a comma-separated key=value
// string saying what to read and where to write it. One per video rendition,
// plus one for the shared audio track. audioPath may be empty for a source
// with no audio at all.
func Args(video []Input, audioPath, outDir string, segmentSeconds int) []string {
	args := make([]string, 0, len(video)+7)

	for _, in := range video {
		dir := fmt.Sprintf("%dp", in.Height)
		args = append(args, strings.Join([]string{
			"in=" + in.Path,
			"stream=video",
			"init_segment=" + filepath.Join(outDir, dir, "init.mp4"),
			"segment_template=" + filepath.Join(outDir, dir, "$Number$.m4s"),
			"playlist_name=" + filepath.Join(dir, "index.m3u8"),
		}, ","))
	}

	// One audio track for the whole ladder. Every video variant in the HLS
	// master references this group, so it is segmented once and cached once.
	if audioPath != "" {
		args = append(args, strings.Join([]string{
			"in=" + audioPath,
			"stream=audio",
			"init_segment=" + filepath.Join(outDir, "audio", "init.mp4"),
			"segment_template=" + filepath.Join(outDir, "audio", "$Number$.m4s"),
			"playlist_name=" + filepath.Join("audio", "index.m3u8"),
			"hls_group_id=audio",
		}, ","))
	}

	args = append(args,
		"--segment_duration", strconv.Itoa(segmentSeconds),
		"--mpd_output", filepath.Join(outDir, DASHManifest),
		"--hls_master_playlist_output", filepath.Join(outDir, HLSManifest),
	)
	return args
}

// ManifestPaths returns where Run will have written the two manifests.
func ManifestPaths(outDir string) (hls, dash string) {
	return filepath.Join(outDir, HLSManifest), filepath.Join(outDir, DASHManifest)
}

// Run packages the renditions into outDir. Cancellation comes from ctx.
func Run(ctx context.Context, video []Input, audioPath, outDir string, segmentSeconds int) error {
	if len(video) == 0 {
		return fmt.Errorf("packaging: no renditions to package")
	}

	dirs := []string{outDir}
	if audioPath != "" {
		dirs = append(dirs, filepath.Join(outDir, "audio"))
	}
	for _, in := range video {
		dirs = append(dirs, filepath.Join(outDir, fmt.Sprintf("%dp", in.Height)))
	}
	for _, d := range dirs {
		if err := os.MkdirAll(d, 0o755); err != nil {
			return fmt.Errorf("packaging: creating %s: %w", d, err)
		}
	}

	// Note what is NOT here: quoting. $Number$ needed single quotes in bash;
	// as argv it is just a string.
	cmd := exec.CommandContext(ctx, "packager", Args(video, audioPath, outDir, segmentSeconds)...)

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
