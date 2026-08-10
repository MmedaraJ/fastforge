# fastforge = FAST channel platform

## Day 1 — Probing the source (ffprobe)

Command: `ffprobe -v quiet -print_format json -show_format -show_streams sources/bbb.mp4`

A video file is not a mystery blob: it's a **container** (the `format` section)
holding **streams** (the `streams` array), each with its own codec and parameters.
Every pipeline starts with a probe.

### What I found (Big Buck Bunny source)

| Property     | Value                                      |
|--------------|--------------------------------------------|
| Video stream | index 0, `h264`, 1920×1080                 |
| Data stream  | index 1, `tmcd` timecode track (see below) |
| Audio stream | index 2, `aac`                             |
| Frame rate   | `24/1` → **24 fps**                        |
| Bitrate      | 9,282,573 b/s ≈ **9,283 kbps ≈ 9.3 Mbps**  |
| Duration     | 596.46 s (~10 min)                         |

### Notes / lessons

- **Bitrate sanity check:** I first computed 928 kbps — off by 10× (÷1000, not
  ÷10000). 1080p masters typically run 5–20 Mbps; "0.9 Mbps at 1080p" should
  have smelled wrong. 9.3 Mbps is a healthy master — my 5000k top rung will be
  compressing down from it, not inflating a starved source.
- **The mystery stream at index 1** is a `tmcd` timecode track left by the
  production/editing pipeline. Containers can carry non-AV streams (timecode,
  chapters, subtitles, metadata). Practical consequence: pipelines should use
  **explicit stream mapping** (`-map a:0`, `-map "[v1out]"`) — a lazy `-map 0`
  would try to encode the timecode track into HLS and fail with a confusing
  error. Select what you want; don't inherit what's there.
- **24 fps changes my ladder math:** segment duration must be a whole multiple
  of GOP duration, and GOP is set in *frames*. For 6-second segments I'll use a
  2-second GOP → `-g 48 -keyint_min 48 -r 24` (NOT the 30fps values `-g 60 -r 30`).
