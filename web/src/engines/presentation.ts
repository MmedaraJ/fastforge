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

/** One audio language: HLS's EXT-X-MEDIA TYPE=AUDIO, DASH's audio AdaptationSet. */
export interface AudioOption {
    /** BCP 47 tag from the manifest: LANGUAGE in HLS, lang in DASH. "" if none. */
    language: string;
    /** What the viewer sees in the menu: NAME in HLS, <Label> in DASH; the tag if there's neither. */
    label: string;
    /** DEFAULT=YES in HLS, Role "main" in DASH: play this unless the viewer says otherwise. */
    isDefault: boolean;
    playlist: MediaPlaylist;
}

/** One subtitle language. Its "segments" are WebVTT text files. */
export interface SubtitleOption {
    language: string;
    label: string;
    isDefault: boolean;
    /**
     * FORCED=YES in HLS, Role "forced-subtitle" in DASH: lines to show even
     * with subtitles off, such as dialogue in a language the audio doesn't use.
     */
    forced: boolean;
    playlist: MediaPlaylist;
}

export interface Presentation {
    /** Lowest bandwidth first: the order every engine reports levels in. */
    rungs: Rung[];
    /** Every audio language, in manifest order. Empty for a silent stream. */
    audio: AudioOption[];
    subtitles: SubtitleOption[];
}