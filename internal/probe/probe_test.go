package probe

import (
	"encoding/json"
	"testing"
)

// What ffprobe printed for a test file with two audio languages: English
// (the default) and Vietnamese. Trimmed to the fields Probe reads.
const twoLanguages = `{
  "streams": [
    {"codec_type": "video", "codec_name": "h264", "width": 1920, "height": 1080, "r_frame_rate": "24/1",
     "tags": {"language": "und"}, "disposition": {"default": 1}},
    {"codec_type": "audio", "codec_name": "aac", "tags": {"language": "eng"}, "disposition": {"default": 1}},
    {"codec_type": "audio", "codec_name": "aac", "tags": {"LANGUAGE": "vie", "title": "Tiếng Việt"}, "disposition": {"default": 0}}
  ],
  "format": {"duration": "30.037000"}
}`

func TestAudioStreams(t *testing.T) {
	var p ffprobeOutput
	if err := json.Unmarshal([]byte(twoLanguages), &p); err != nil {
		t.Fatal(err)
	}
	r, err := parseProbeOutput("two_languages.mp4", p)
	if err != nil {
		t.Fatal(err)
	}
	if r.AudioCodec != "aac" {
		t.Errorf("AudioCodec = %q, want \"aac\"", r.AudioCodec)
	}
	want := []AudioStream{
		{Index: 0, Codec: "aac", Language: "eng", Default: true},
		{Index: 1, Codec: "aac", Language: "vie", Title: "Tiếng Việt"},
	}
	if len(r.AudioStreams) != len(want) {
		t.Fatalf("got %d audio streams, want %d", len(r.AudioStreams), len(want))
	}
	for i := range want {
		if r.AudioStreams[i] != want[i] {
			t.Errorf("stream %d = %+v, want %+v", i, r.AudioStreams[i], want[i])
		}
	}
}

func TestUndeterminedLanguageIsEmpty(t *testing.T) {
	p := ffprobeOutput{
		Streams: []stream{
			{CodecType: "video", CodecName: "h264", RFrameRate: "24/1"},
			{CodecType: "audio", CodecName: "aac", Tags: map[string]string{"language": "und"}},
		},
		Format: format{Duration: "1"},
	}
	r, err := parseProbeOutput("x.mp4", p)
	if err != nil {
		t.Fatal(err)
	}
	if got := r.AudioStreams[0].Language; got != "" {
		t.Errorf("Language = %q, want \"\" for und", got)
	}
}
