// internal/ladder/ladder_test.go
package ladder

import (
	"reflect"
	"testing"

	"github.com/MmedaraJ/fastforge/internal/probe"
)

func TestBuildLadder(t *testing.T) {
	tests := []struct {
		name    string
		src     probe.Result
		specs   []RungSpec
		segSecs int
		want    []Rung
		wantErr bool
	}{
		{
			name:    "1080p 30fps source: full ladder",
			src:     probe.Result{Width: 1920, Height: 1080, FPS: 30},
			specs:   DefaultLadder,
			segSecs: 6,
			want: []Rung{
				{VideoCodec: "h264", AudioCodec: "aac", Width: 1920, Height: 1080, GOP: 60, FPS: 30, BitrateKbps: 5000, MaxrateKbps: 5350, BufsizeKbps: 7500, AudioBitrateKbps: 128},
				{VideoCodec: "h264", AudioCodec: "aac", Width: 1280, Height: 720, GOP: 60, FPS: 30, BitrateKbps: 2800, MaxrateKbps: 2996, BufsizeKbps: 4200, AudioBitrateKbps: 128},
				{VideoCodec: "h264", AudioCodec: "aac", Width: 854, Height: 480, GOP: 60, FPS: 30, BitrateKbps: 1400, MaxrateKbps: 1498, BufsizeKbps: 2100, AudioBitrateKbps: 96},
			},
		},
		{
			// 480 rung: 1280*480/720 = 853.33 → 854, NOT 853.
			// H.264 4:2:0 requires even dimensions; round to nearest even.
			name:    "720p source: 1080 rung dropped, odd width rounded up to even",
			src:     probe.Result{Width: 1280, Height: 720, FPS: 30},
			specs:   DefaultLadder,
			segSecs: 6,
			want: []Rung{
				{VideoCodec: "h264", AudioCodec: "aac", Width: 1280, Height: 720, GOP: 60, FPS: 30, BitrateKbps: 2800, MaxrateKbps: 2996, BufsizeKbps: 4200, AudioBitrateKbps: 128},
				{VideoCodec: "h264", AudioCodec: "aac", Width: 854, Height: 480, GOP: 60, FPS: 30, BitrateKbps: 1400, MaxrateKbps: 1498, BufsizeKbps: 2100, AudioBitrateKbps: 96},
			},
		},
		{
			// DECISION (override if you disagree): never upscale, but always
			// produce something playable — when the source is below every rung,
			// emit ONE rung at the source's own height using the lowest spec's
			// bitrate settings.
			name:    "360p source: single rung at source height, no upscale",
			src:     probe.Result{Width: 640, Height: 360, FPS: 30},
			specs:   DefaultLadder,
			segSecs: 6,
			want: []Rung{
				{VideoCodec: "h264", AudioCodec: "aac", Width: 640, Height: 360, GOP: 60, FPS: 30, BitrateKbps: 1400, MaxrateKbps: 1498, BufsizeKbps: 2100, AudioBitrateKbps: 96},
			},
		},
		{
			// DECISION: round 29.97 → 30 and compute GOP against the rounded
			// value. One rounding rule, one place. Rung.FPS carries the encode
			// target (what -r will be), not the source measurement.
			name:    "29.97fps source: fps rounded to 30, GOP 60",
			src:     probe.Result{Width: 1280, Height: 720, FPS: 29.97},
			specs:   DefaultLadder,
			segSecs: 6,
			want: []Rung{
				{VideoCodec: "h264", AudioCodec: "aac", Width: 1280, Height: 720, GOP: 60, FPS: 30, BitrateKbps: 2800, MaxrateKbps: 2996, BufsizeKbps: 4200, AudioBitrateKbps: 128},
				{VideoCodec: "h264", AudioCodec: "aac", Width: 854, Height: 480, GOP: 60, FPS: 30, BitrateKbps: 1400, MaxrateKbps: 1498, BufsizeKbps: 2100, AudioBitrateKbps: 96},
			},
		},
		{
			// 25fps × 6s segments → GOP 50 (2s GOP). Proves the math isn't
			// hardcoded to 30fps.
			name:    "25fps source: GOP follows fps",
			src:     probe.Result{Width: 1280, Height: 720, FPS: 25},
			specs:   DefaultLadder,
			segSecs: 6,
			want: []Rung{
				{VideoCodec: "h264", AudioCodec: "aac", Width: 1280, Height: 720, GOP: 50, FPS: 25, BitrateKbps: 2800, MaxrateKbps: 2996, BufsizeKbps: 4200, AudioBitrateKbps: 128},
				{VideoCodec: "h264", AudioCodec: "aac", Width: 854, Height: 480, GOP: 50, FPS: 25, BitrateKbps: 1400, MaxrateKbps: 1498, BufsizeKbps: 2100, AudioBitrateKbps: 96},
			},
		},
		{
			// DECISION: a broken probe is a permanent, upstream problem —
			// fail loudly here rather than emit a ladder built on garbage.
			// The worker turns this into asset status='failed'.
			name:    "fps 0 (broken probe): error",
			src:     probe.Result{Width: 1920, Height: 1080, FPS: 0},
			specs:   []RungSpec{},
			segSecs: 6,
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := BuildLadder(tt.src, tt.specs, tt.segSecs)

			if tt.wantErr {
				if err == nil {
					t.Fatalf("expected an error, got none (ladder=%+v)", got)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if !reflect.DeepEqual(got, tt.want) {
				t.Errorf("ladder mismatch\n got: %+v\nwant: %+v", got, tt.want)
			}
		})
	}
}
