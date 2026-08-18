package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
)

type ProbeResult struct {
	File       string
	VideoCodec string
	Width      int
	Height     int
	FPS        float64
	Duration   float64
	AudioCodec string
	Err        error
}

type Stream struct {
	CodecType  string `json:"codec_type"` // "video" or "audio"
	CodecName  string `json:"codec_name"`
	Width      int    `json:"width"`
	Height     int    `json:"height"`
	RFrameRate string `json:"r_frame_rate"` // "30000/1001"
}

type Format struct {
	Duration string `json:"duration"`
}

type ProbeOutput struct {
	Streams []Stream `json:"streams"`
	Format  Format   `json:"format"`
}

// exec → Unmarshal → loop streams for video/audio → parse fps fraction →
// ParseFloat duration → send the result
// (errors included as results, never printed from inside probe).
func probe(file string, results chan<- ProbeResult, wg *sync.WaitGroup) {
	defer wg.Done()

	cmd := exec.Command("ffprobe", "-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", file)

	out, err := cmd.Output() // runs it, waits, returns stdout as []byte
	if err != nil {
		results <- ProbeResult{File: file, Err: fmt.Errorf("ffprobe failed: %w", err)}
		return
	}

	var p ProbeOutput
	if err := json.Unmarshal(out, &p); err != nil {
		results <- ProbeResult{File: file, Err: fmt.Errorf("parsing ffprobe output: %w", err)}
		return
	}

	results <- parseProbeOutput(file, p)
}

func parseProbeOutput(file string, p ProbeOutput) ProbeResult {
	var result ProbeResult

	result.File = file
	result.AudioCodec = "none"

	streams := p.Streams
	parseStreams(file, streams, &result)

	if result.Err != nil {
		return result
	}

	format := p.Format
	parseFormat(format, &result)

	return result
}

func parseFormat(format Format, result *ProbeResult) {
	duration, err := strconv.ParseFloat(format.Duration, 64)

	if err == nil {
		result.Duration = duration
	} else {
		result.Err = fmt.Errorf("parsing duration %q: %w", format.Duration, err)
	}
}

func parseStreams(file string, streams []Stream, result *ProbeResult) {
	foundVideo := false

	for _, stream := range streams {
		switch stream.CodecType {
		case "video":
			if !foundVideo {
				foundVideo = true
				result.VideoCodec = stream.CodecName
				result.Width = stream.Width
				result.Height = stream.Height
				result.FPS = parseFPS(stream.RFrameRate)
			}
		case "audio":
			if result.AudioCodec == "none" {
				result.AudioCodec = stream.CodecName
			}
		}
	}

	if !foundVideo {
		result.Err = fmt.Errorf("no video stream in %s", file)
	}
}

func parseFPS(fps string) float64 {
	parts := strings.Split(fps, "/")

	if len(parts) != 2 || parts[1] == "0" {
		return 0.0
	}

	numerator, err1 := strconv.ParseFloat(parts[0], 64)
	denominator, err2 := strconv.ParseFloat(parts[1], 64)

	if err1 != nil || err2 != nil {
		return 0.0
	}

	return numerator / denominator
}

func main() {
	files := os.Args[1:]
	if len(files) == 0 {
		fmt.Fprintln(os.Stderr, "usage: probe <file> [file...]")
		os.Exit(1)
	}

	results := make(chan ProbeResult)

	var wg sync.WaitGroup

	for _, file := range files {
		wg.Add(1)
		go probe(file, results, &wg)
	}

	// Or wg.Add(len(files)) before spawn loop above
	// Dont call the wait goroutine before registering the main goroutines
	go func() {
		wg.Wait()
		close(results)
	}()

	failed := false
	for r := range results {
		if r.Err != nil {
			failed = true
			fmt.Printf("%-24s ERROR  %v\n", r.File, r.Err)
			continue
		}
		fmt.Printf("%-24s %-6s %4dx%-4d %6.2ffps %8.1fs audio=%s\n",
			r.File, r.VideoCodec, r.Width, r.Height, r.FPS, r.Duration, r.AudioCodec)
	}

	if failed {
		os.Exit(1)
	}
}
