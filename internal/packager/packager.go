package packager

import (
	"bytes"
	"context"
	"encoding/hex"
	"fmt"
	"io/fs"
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
	// Encryption is nil for a clear asset.
	Encryption *Encryption
}

// The two ways an asset can be encrypted. The same words are DRM_MODE's
// values and assets.drm's.
const (
	// ModeClearKey: your key, from your key store, licensed by your server.
	ModeClearKey = "clearkey"
	// ModeWidevineTest: a key from Google's Widevine test key server,
	// licensed by Google's test licence server. Development only.
	ModeWidevineTest = "widevine-test"
)

// Google's public test credentials, printed in Shaka Packager's Widevine
// tutorial. They let anyone get test keys, which is exactly why they can
// only ever protect test content.
const (
	widevineTestKeyServer  = "https://license.uat.widevine.com/cenc/getcontentkey/widevine_test"
	widevineTestSigner     = "widevine_test"
	widevineTestSigningKey = "1ae8ccd0e7985cc0b6203a55855a1034afc252980e970ca90e5202689f947ab9"
	widevineTestSigningIV  = "d58ce954203b7c9a9a9d467f59839249"
)

// Encryption says how to encrypt a job.
type Encryption struct {
	Mode string
	// ModeClearKey: the content key and its ID.
	KeyID, Key [16]byte
	// ModeWidevineTest: names the content to Google's key server, which
	// derives the key from it. The asset ID.
	ContentID string
	// Seconds at the start left unencrypted, so playback can begin before
	// the licence arrives. Rounded up to whole segments by the packager.
	ClearLeadSeconds int
}

// encryptionArgs is the packager's half of DRM: which scheme, which key,
// which PSSH boxes to write.
func encryptionArgs(e *Encryption) []string {
	args := []string{
		// cbcs, the one scheme Widevine, PlayReady and FairPlay all decrypt,
		// so one set of files serves every DRM system and both formats.
		"--protection_scheme", "cbcs",
		"--clear_lead", strconv.Itoa(e.ClearLeadSeconds),
	}
	switch e.Mode {
	case ModeClearKey:
		return append(args,
			"--enable_raw_key_encryption",
			// An empty label applies the key to every audio and video stream.
			// This argument is the one place the key exists outside the key
			// store: on the packager's command line while it runs, readable
			// only inside the worker's container. Never log args.
			"--keys", fmt.Sprintf("label=:key_id=%x:key=%x", e.KeyID, e.Key),
			// CommonSystem writes the W3C common PSSH (a list of key IDs),
			// which is what a Clear Key CDM reads.
			"--protection_systems", "CommonSystem",
		)
	case ModeWidevineTest:
		return append(args,
			"--enable_widevine_encryption",
			"--key_server_url", widevineTestKeyServer,
			"--content_id", hex.EncodeToString([]byte(e.ContentID)),
			"--signer", widevineTestSigner,
			"--aes_signing_key", widevineTestSigningKey,
			"--aes_signing_iv", widevineTestSigningIV,
			"--protection_systems", "Widevine",
		)
	}
	return nil
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

	if j.Encryption != nil {
		args = append(args, encryptionArgs(j.Encryption)...)
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
	if e := j.Encryption; e != nil && e.Mode != ModeClearKey && e.Mode != ModeWidevineTest {
		return fmt.Errorf("packaging: unknown encryption mode %q", e.Mode)
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
	if e := j.Encryption; e != nil && e.Mode == ModeClearKey {
		return markClearKey(j.OutDir)
	}

	return nil
}

// markClearKey relabels the HLS key lines of a Clear Key asset.
//
// For the common system, Shaka Packager writes each media playlist's key as
// KEYFORMAT="identity" with the key ID in a data: URI. "identity" means the
// URI holds the key itself, so players read it differently: hls.js refuses
// identity in fMP4, and Shaka Player decrypts with the key ID as if it were
// the key. HLS has no standard Clear Key KEYFORMAT; "org.w3.clearkey", with
// the key ID in the URI, is hls.js's convention, and the one your MSE engine
// reads. Shaka Player doesn't accept it, so it plays Clear Key over DASH only.
func markClearKey(dir string) error {
	return filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || d.Name() != "index.m3u8" {
			return err
		}
		playlist, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		relabelled := bytes.ReplaceAll(playlist, []byte(`KEYFORMAT="identity"`), []byte(`KEYFORMAT="org.w3.clearkey"`))
		if bytes.Equal(relabelled, playlist) {
			return nil
		}
		return os.WriteFile(path, relabelled, 0o644)
	})
}
