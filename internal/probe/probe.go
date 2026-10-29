package probe

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"strconv"
	"strings"
)

type Result struct {
	VideoCodec string
	Width      int
	Height     int
	FPS        float64
	DurationS  float64
	AudioCodec string
}

type stream struct {
	CodecType  string `json:"codec_type"` // "video" or "audio"
	CodecName  string `json:"codec_name"`
	Width      int    `json:"width"`
	Height     int    `json:"height"`
	RFrameRate string `json:"r_frame_rate"` // "30000/1001"
}

type format struct {
	Duration string `json:"duration"`
}

type ffprobeOutput struct {
	Streams []stream `json:"streams"`
	Format  format   `json:"format"`
}

func Probe(ctx context.Context, path string) (Result, error) {
	if path == "" {
		return Result{}, fmt.Errorf("empty path")
	}

	cmd := exec.CommandContext(ctx, "ffprobe", "-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", path)

	out, err := cmd.Output() // runs it, waits, returns stdout as []byte
	if err != nil {
		return Result{}, fmt.Errorf("ffprobe failed: %w", err)
	}

	var p ffprobeOutput
	if err := json.Unmarshal(out, &p); err != nil {
		return Result{}, fmt.Errorf("parsing ffprobe output: %w", err)
	}

	return parseProbeOutput(path, p)
}

func parseProbeOutput(path string, p ffprobeOutput) (Result, error) {
	var result Result

	streams := p.Streams
	result, err := parseStreams(path, streams, result)

	if err != nil {
		return Result{}, fmt.Errorf("parsing probe result: %w", err)
	}

	format := p.Format
	return parseFormat(format, result)
}

func parseFormat(format format, result Result) (Result, error) {
	duration, err := strconv.ParseFloat(format.Duration, 64)

	if err == nil {
		result.DurationS = duration
		return result, nil
	} else {
		return Result{}, fmt.Errorf("parsing duration %q: %w", format.Duration, err)
	}
}

func parseStreams(path string, streams []stream, result Result) (Result, error) {
	foundVideo := false

	for _, stream := range streams {
		switch stream.CodecType {
		case "video":
			if !foundVideo {
				foundVideo = true
				result.VideoCodec = stream.CodecName
				result.Width = stream.Width
				result.Height = stream.Height

				frameRate, err := parseFPS(stream.RFrameRate)
				if err != nil {
					return Result{}, fmt.Errorf("parsing frame rate of %v: %w", path, err)
				}
				result.FPS = frameRate
			}
		case "audio":
			if result.AudioCodec == "" {
				result.AudioCodec = stream.CodecName
			}
		}
	}

	if !foundVideo {
		return Result{}, fmt.Errorf("no video stream in %s", path)
	}

	return result, nil
}

func parseFPS(fps string) (float64, error) {
	parts := strings.Split(fps, "/")

	if len(parts) != 2 || parts[1] == "0" {
		return 0.0, fmt.Errorf("unparseable frame rate foo/bar")
	}

	numerator, err1 := strconv.ParseFloat(parts[0], 64)
	denominator, err2 := strconv.ParseFloat(parts[1], 64)

	if err1 != nil {
		return 0.0, fmt.Errorf("frame rate does not have a valid numerator")
	}

	if err2 != nil {
		return 0.0, fmt.Errorf("frame rate does not have a valid denominator")
	}

	return numerator / denominator, nil
}
