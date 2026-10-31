package ladder

import (
	"fmt"
	"math"

	"github.com/MmedaraJ/fastforge/internal/probe"
)

const (
	VideoCodec = "h264"
	AudioCodec = "aac"
	gopSeconds = 2

	// SegmentSeconds is the packaging constraint the ladder is built against.
	// It must stay a whole multiple of gopSeconds, or segments stop landing on
	// keyframes. The packager must be given this same value.
	SegmentSeconds = 6
)

// RungSpec is the configured intent for one ladder rung —
// what we'd produce given an ideal source.
type RungSpec struct {
	Height           int
	BitrateKbps      int
	MaxrateKbps      int
	BufsizeKbps      int
	AudioBitrateKbps int
}

// The output of BuildLadder() which goes to ffmpeg
type Rung struct {
	VideoCodec       string
	Width            int
	Height           int
	GOP              int
	FPS              int
	BitrateKbps      int
	MaxrateKbps      int
	BufsizeKbps      int
	AudioBitrateKbps int
	AudioCodec       string
}

// DefaultLadder is the standard three-rung ABR ladder, matching the
// week-1 hand-built ladder: ~1.5–2x spacing between adjacent rungs.
var DefaultLadder = []RungSpec{
	{Height: 1080, BitrateKbps: 5000, MaxrateKbps: 5350, BufsizeKbps: 7500, AudioBitrateKbps: 128},
	{Height: 720, BitrateKbps: 2800, MaxrateKbps: 2996, BufsizeKbps: 4200, AudioBitrateKbps: 128},
	{Height: 480, BitrateKbps: 1400, MaxrateKbps: 1498, BufsizeKbps: 2100, AudioBitrateKbps: 96},
}

// AudioTrack is the single audio rendition shared by every video rung.
// With demuxed audio there is one encode, one set of segments, and every
// variant in the manifest points at it.
type AudioTrack struct {
	Codec       string
	BitrateKbps int
}

// BuildAudioTrack picks the settings for the shared audio track.
//
// It takes the HIGHEST audio bitrate in the ladder, because one track now
// serves every rung: you cannot save bits on the 480p rung's audio without
// also degrading audio for someone watching at 1080p. The per-rung
// AudioBitrateKbps becomes a ceiling vote rather than a per-rung setting.
func BuildAudioTrack(specs []RungSpec) AudioTrack {
	best := 0
	for _, s := range specs {
		if s.AudioBitrateKbps > best {
			best = s.AudioBitrateKbps
		}
	}
	if best == 0 {
		best = 128 // empty ladder: a sane default rather than a silent 0k encode
	}
	return AudioTrack{Codec: AudioCodec, BitrateKbps: best}
}

// - probe probe.Result — reality: what the uploaded video actually is (its width, height, fps).
// Produced by ffprobe upstream; this function just trusts it (except when it's nonsense — see the guard).
// - specs []RungSpec — policy: the renditions we'd like to produce in an
// ideal world (heights + bitrate settings). Usually DefaultLadder.
// - segmentSeconds int — the packaging constraint: segments must cut on keyframes,
// so segment duration dictates what GOP values are legal (your Day 1 math: GOP duration must divide segment duration).
func BuildLadder(src probe.Result, specs []RungSpec, segmentSeconds int) ([]Rung, error) {
	if segmentSeconds%gopSeconds != 0 {
		return nil, fmt.Errorf("segmentSeconds should be a foactor of %d", gopSeconds)
	}

	probeFPS := src.FPS
	if probeFPS < 1 {
		return nil, fmt.Errorf("building ladder: FPS is less than 1")
	}

	encodeFPS := int(math.Round(probeFPS))
	encodeGOP := encodeFPS * gopSeconds

	rungs := []Rung{}
	for _, spec := range specs {
		if spec.Height > src.Height {
			continue
		}

		width := src.Width * spec.Height / src.Height
		if width%2 == 1 {
			width++
		}

		rungs = append(rungs, newRung(spec, width, spec.Height, encodeGOP, encodeFPS))
	}

	// Dont upscale in this fall back. Take height and width from source
	if len(rungs) < 1 {
		lowest := specs[len(specs)-1]
		rungs = append(rungs, newRung(lowest, src.Width, src.Height, encodeGOP, encodeFPS))
	}

	return rungs, nil
}

func newRung(spec RungSpec, width int, height int, gop int, fps int) Rung {
	return Rung{
		VideoCodec:       VideoCodec,
		Width:            width,
		Height:           height,
		GOP:              gop,
		FPS:              fps,
		BitrateKbps:      spec.BitrateKbps,
		MaxrateKbps:      spec.MaxrateKbps,
		BufsizeKbps:      spec.BufsizeKbps,
		AudioBitrateKbps: spec.AudioBitrateKbps,
		AudioCodec:       AudioCodec,
	}
}
