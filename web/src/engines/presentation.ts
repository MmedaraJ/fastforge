import type { MediaPlaylist } from "./hls/playlist";

/*
 * What the MSE engine needs from a manifest, whatever its format: the video
 * rungs, each with its own list of segments, and the audio. The HLS path and
 * the DASH parser both produce this shape, so mse.ts never sees a format.
 * That split (a format layer on top, one media layer underneath) is how
 * Shaka and Video.js play both HLS and DASH with one engine.
 */

export interface Rung {
    /**
     * Bits per second for video and audio together. HLS's BANDWIDTH already
     * counts both; DASH lists them separately, so the DASH parser adds them.
     * Every engine then reports the same kbps for the same rung.
     */
    bandwidth: number;
    height: number;
    /** e.g. ["avc1.64001e", "mp4a.40.2"]: mimeFor() builds SourceBuffer types from these. */
    codecs: string[];
    /** This rung's init segment and segments, with start times in seconds. */
    playlist: MediaPlaylist;
}

export interface Presentation {
    /** Lowest bandwidth first: the order every engine reports levels in. */
    rungs: Rung[];
    audio: MediaPlaylist | null;
    /** How many audio renditions the manifest offers, for the "N audio track(s)" log line. */
    audioTracks: number;
}