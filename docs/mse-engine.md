# fastforge MSE engine (Milestone 11)

HLS (fMP4/CMAF, VOD, demuxed audio) played through Media Source Extensions
with no player library: src/engines/mse.ts and src/engines/hls/playlist.ts.

## How it works
- One loop per track: while less than 30 s is buffered ahead, fetch the next
  segment and append it. One SourceBuffer operation at a time per track.
- A switch = the new rung's init segment, then the same segment number on that
  rung (keyframes are aligned across the ladder).
- A seek continues from the end of the buffered range at the new position, or
  from the segment containing it, and cancels downloads for the old position.
- endOfStream() once every track has its last segment, so `ended` fires.
- Switches are reported when shown, not when requested.

## Numbers and where they come from
- 30 s ahead: hls.js's maxBufferLength default (Shaka's bufferingGoal is 10 s).
- 30 s behind: Shaka's bufferBehind default (hls.js keeps everything).
- 3 attempts, 0.5 s then 1 s apart: my choice. hls.js retries a fragment up
  to 6 times, 1 s to 8 s apart; Shaka makes 2 attempts, 1 s base delay.
- 250 ms timer: my choice; the loop also runs as soon as a segment lands.

## What it leaves out, and what hls.js does instead
- Live playlists: reloading, the sliding window, the live edge
- MPEG-TS segments: hls.js transmuxes TS to fMP4 in a web worker
- Request timeouts: hls.js allows 10 s to first byte, 120 s in total
- The emergency down-switch mid-download
- Gap jumping and stall recovery
- Switching quality immediately by flushing what's buffered
- Multiple audio languages, subtitles, DRM

## Bug found while testing
A seek near the end skipped the 0.042 s last segment, because the next-segment
lookup used a fixed 50 ms allowance. It now uses half of each segment's
length. hls.js caps its lookup tolerance at the segment duration for the
same reason.