# Audio languages and subtitles

Test asset: the 30 s clip with an English and a Vietnamese audio stream
(5 kHz and 7 kHz pilot tones) and English and Vietnamese WebVTT files,
through the pipeline. Chrome throttle 2,500 kbit/s down, 100 ms latency,
cache disabled, throughput rule, so every engine plays 480p. Medians of three
sessions.

## Pipeline

- The probe reads every audio stream's language, title and default flag.
  Each language is encoded once (`-map 0:a:N`) and packaged into one audio
  group, so every rung plays with every language.
- Subtitles are uploaded with the video as `<language>.vtt`, checked at
  upload (name, size, WEBVTT header) and cut into 6 s WebVTT segments that
  HLS and DASH share.
- `--default_language` marks the source's default audio. `--default_text_language zxx`
  keeps every subtitle track `DEFAULT=NO`, because hls.js shows `DEFAULT=YES`
  subtitles without being asked.
- A `tracks` table records what the manifests offer; `GET /assets/{id}` returns it.

## Switching audio language

| Engine | Heard | Reported | Longest silence | Stalls | First subtitle |
| --- | --- | --- | --- | --- | --- |
| hls.js · HLS | 821 ms | 450 ms | 0 | 0 | 362 ms |
| Shaka · HLS | 886 ms | 0 ms | 360–380 ms | 1 | 3,785 ms |
| Shaka · DASH | 441 ms | 0 ms | under 20 ms | 1 | 121 ms |
| fastforge MSE · HLS | 705 ms | 340 ms | 0 | 0 | 121 ms |
| fastforge MSE · DASH | 719 ms | 340 ms | 0 | 0 | 122 ms |

"Heard" is when the 7 kHz tone takes over, read with a WebAudio analyser;
"reported" is when the engine says the language changed.

- My engine downloads the new language first, then cuts the old one 0.25 s
  ahead of the playhead and appends: no silence, no stall. Cutting first
  stalls (Shaka's default). Appending over a 2 s margin was heard only after
  2.13 s, because Chrome plays audio frames it has already read.
- Shaka · HLS shows the first subtitle only after the next video segment is
  appended. Adding X-TIMESTAMP-MAP didn't change that.

## Going back in a feed

| | Before | After |
| --- | --- | --- |
| Estimate at the first decision | 372,216 to 601,882 kbps | 2,221 kbps |
| Rung asked for | 720p, 0.04 s after the press | 480p |
| Press to first frame | 184 to 191 ms | 78 to 118 ms |

Segments watched a minute ago came from the HTTP cache in 3 to 31 ms and were
timed as downloads. Downloads under 50 ms are no longer measured; dash.js
makes the same call at 10 ms.

## Not done

- Forced subtitles (FORCED=YES) aren't shown while subtitles are off.
- Shaka · HLS's 3.7 s to the first subtitle: cause not traced.
- Shaka's safeMargin, which keeps old audio while the new loads, not measured.