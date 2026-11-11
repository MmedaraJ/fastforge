# Resume bullets

Use the first list now. Fill in the second list's numbers once the Milestone 9 and 10 experiment runs are done. Add each later bullet only once that phase is built. Label all of it as a personal project, and keep every number tied to how it was measured.

## Ready now

**fastforge — FAST-channel streaming platform (personal project)** · Go, TypeScript, FFmpeg, Shaka Packager, hls.js, Shaka Player, Media Source Extensions, PostgreSQL, Docker, Cloudflare R2 and CDN

- Built a video ingest and transcode pipeline in Go: a Postgres-backed job queue (River) runs FFmpeg to encode an H.264 bitrate ladder with capped VBV and keyframes aligned across renditions, then packages it to CMAF with Shaka Packager, serving one set of segments as both HLS and DASH.
- Added a VMAF quality stage (harmonic-mean pooling, a floor on the top rung) and used it to evaluate the ladder: on animated content 1080p scored 95.7, 720p 91.3 and 480p 83.0, so the 720p-to-1080p step added 4.4 points, under one just-noticeable difference.
- Delivered segments through Cloudflare R2 and its CDN with caching set per file type (immutable segments, short-lived manifests), and confirmed tiered caching: one origin fetch served edges in Hong Kong, Tokyo and Singapore.
- Containerized the API and worker with multi-stage Docker builds that pin FFmpeg (with libvmaf) and Shaka Packager and fail the build if either is missing.
- Built a TypeScript web player with a QoE model (startup time, rebuffer ratio, time-weighted bitrate, switches, dropped frames) that keeps startup, seeks and end of stream out of the rebuffer count, and reports sessions through sendBeacon into Postgres with at-least-once delivery and server-side deduplication.
- Implemented two ABR algorithms, throughput-based (fast and slow moving averages, cautious up-switching) and buffer-based (BOLA-style), plus an in-page experiment runner that interleaves trials in random order and discards trials that fail setup checks.
- Put playback behind an engine interface with four implementations: hls.js, Shaka Player through a custom AbrManager plugin, my own Media Source Extensions engine, and the browser's native HLS for devices without Media Source Extensions.
- Wrote a playback engine directly on Media Source Extensions with no player library, playing HLS and DASH from the same CMAF segments: per-track segment scheduling, buffer limits and eviction, rendition switching, seeking and end of stream.
- Traced a 1.3 s startup gap between my hand-written MSE player and Shaka Player to audio prefetch competing with the first video segment for bandwidth; pacing audio behind video and requesting init and media segments together cut first frame from 5.35 s to 4.02 s at 2.5 Mbit/s, level with Shaka.
- Built next-video preloading for a short-video feed: the next video shows its first frame under 60 ms after the swipe instead of 4.1 s, for 1.16 MB per preload, with preloaded bytes kept out of the ABR's bandwidth estimate.

The VMAF figures come from the containerized pipeline run (95.70, 91.30, 83.03). The startup and feed figures come from Claude's runs of the Milestone 12 guide (Chrome throttle 2,500 kbit/s and 100 ms, on a copy of the 30 s clip); swap in yours from `docs/startup.md` once you've written it.

## Add once Milestone 13 is built

- Added multi-language audio and WebVTT subtitles end to end: the Go pipeline probes every audio stream, encodes each language once and packages all of them into one HLS audio group and per-language DASH AdaptationSets, with subtitles uploaded alongside the video and cut into segments both formats share.
- Implemented mid-play audio-language switching in my Media Source Extensions player by downloading the new language before cutting the old one 0.25 s ahead of the playhead: heard in about 0.7 s with no silence or stall, against 0.82 s for hls.js and a stall on every switch with Shaka Player's defaults.
- Found that scrolling back in a short-video feed timed cached segments as downloads, reading 370,000 to 600,000 kbps on a 2.5 Mbit/s link and pushing ABR to a rung the link couldn't carry; skipping downloads under 50 ms kept the estimate at the link's 2.2 Mbps.

These figures come from Claude's runs of the Milestone 13 guide (same throttle, three sessions per engine, Nov 10 and 11). Move each bullet up to Ready now once it's built, with your numbers from `docs/languages.md`.

## Add when the results are in

- Compared throughput-based and BOLA-style ABR with hls.js's built-in ABR in randomized, interleaved trials on throttled networks: at ~2.15 Mbps measured, opening on the lowest rung cut median startup from 6.1 s to 4.0 s with no added rebuffering; at ~1.2 Mbps every algorithm stalled about 7% of the time, showing the ladder needed a lower rung rather than a different algorithm. Numbers from `docs/abr-results.md`; add the session count per arm from the query before using it.
- Compared hls.js with Shaka Player, and HLS with DASH from the same CMAF segments, at about 2.5 Mbps over [N] sessions: [finding, with its numbers].
- Contributed a fix to Shaka Player: [PR title] (#[number]). Add this only once it is merged.

Take the numbers from the runner's printed query or `queries/abr_comparison.sql`, and quote the network and session count with them.

## Unlock later

Add each row only once that part is built, and fill the brackets from your own measurements.

| Phase | Bullet |
| --- | --- |
| 2 · DRM | Added Widevine DRM through EME with a test licence server, plus signed segment URLs. |
| 3 | Built a linear channel scheduler and per-session server-side ad insertion in Go (manifest stitching, SCTE-35-style cues, VAST), load-tested to [N] concurrent sessions with k6. |
| 3b | Added live ingest (OBS to RTMP to real-time FFmpeg) into a sliding-window HLS writer with low-latency HLS, splicing live segments into the linear channel. |
| 4 | Built a beacon ingest service into ClickHouse with Grafana dashboards, and an AI layer (Whisper transcripts, pgvector retrieval) that proposes ad-break points. |
| 5 | Deployed the platform to Kubernetes (k3s) with GitHub Actions CI. |
