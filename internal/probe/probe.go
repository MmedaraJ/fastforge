package probe

type Result struct {
	VideoCodec string
	Width      int
	Height     int
	FPS        float64
	DurationS  float64
	AudioCodec string
}
