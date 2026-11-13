/**
 * The contract every playback engine fulfils. player.ts depends only on this
 * file; nothing outside src/engines/ may import hls.js or Shaka.
 */

export type EngineName = "hlsjs" | "shaka" | "native" | "mse";
export type Protocol = "hls" | "dash";

export interface LevelInfo {
    /** Position in the list sorted by bitrate, lowest first. */
    index: number;
    height: number;
    bitrateKbps: number;
}

export interface EngineCallbacks {
    /**
     * Called once, after the manifest is read and BEFORE any media segment is
     * requested.
     *
     * The receiver must call engine.start() before this callback returns. That
     * rule exists because of Shaka: it asks its AbrManager for the opening
     * variant immediately after reporting the variants, inside the same call.
     * If start() came later, Shaka would already have chosen.
     */
    onManifest(levels: LevelInfo[], audioTracks: number): void;

    /** The rendition being played changed. */
    onSwitch(index: number): void;

    /**
     * A VIDEO media segment finished downloading. Engines must leave out audio
     * and init segments: they're small enough that their timing is mostly
     * latency, which would understate the network's speed.
     */
    onDownload(bytes: number, seconds: number): void;

    onError(detail: string, fatal: boolean): void;

    /**
     * The audio and subtitle menus, and which entries are in use. Called once
     * the manifest is read, and again whenever a choice changes. When that
     * is depends on the engine: Shaka reports a new audio language as soon
     * as it's chosen, hls.js once a fragment of it is buffered at the
     * playhead, yours once its first segment is appended. None of them knows
     * when it's heard.
     */
    onTracks(tracks: TrackList): void;
}

/**
 * What an encrypted asset needs to play, from POST /assets/{id}/playback.
 * The engine is given it, rather than finding it in the manifest, because
 * the token belongs to this viewer and this playback, not to the asset.
 */
export interface DrmConfig {
    /** The EME name: "org.w3.clearkey" or "com.widevine.alpha". */
    keySystem: string;
    /** Absolute. Where the CDM's licence requests go. */
    licenseUrl: string;
    /** Sent as "Authorization: Bearer <token>" with every licence request. */
    token: string;
}

export interface EngineOptions extends EngineCallbacks {
    /**
     * True when your own ABR algorithm chooses renditions. False means the
     * engine's built-in ABR does, which is the control arm of experiments.
     */
    ownAbr: boolean;
    /** Null for a clear asset. */
    drm: DrmConfig | null;
}

export interface Engine {
    load(url: string): Promise<void>;

    /** Begin fetching media, opening at this level. -1 = the engine's own choice. */
    start(openingLevel: number): void;

    /** Your ABR's choice for upcoming segments. Ignored while a level is pinned. */
    requestLevel(index: number): void;

    /** The level dropdown. -1 = automatic, otherwise pin that level. */
    setLevel(index: number): void;

    /** False while the viewer has pinned a level. */
    readonly autoEnabled: boolean;

    /** Play this audio language: an id from onTracks. */
    selectAudio(id: number): void;

    /** Show these subtitles: an id from onTracks, or -1 to turn them off. */
    selectText(id: number): void;

    /**
     * Asynchronous because detaching a MediaSource from a <video> element is.
     * Attaching a new engine to the same element before the old one has let go
     * can leave the two fighting over it.
     */
    destroy(): Promise<void>;
}

/** One choice in the audio or subtitles menu. */
export interface TrackInfo {
    /** What selectAudio() or selectText() takes: a position in the engine's own list. */
    id: number;
    /** BCP 47 tag from the manifest, such as "en" or "vi". */
    language: string;
    /** Text for the menu: NAME in HLS, <Label> in DASH; engines fall back on the tag without one. */
    label: string;
}

export interface TrackList {
    audio: TrackInfo[];
    text: TrackInfo[];
    /** The audio language being heard, -1 before the first is known. */
    audioId: number;
    /** The subtitles showing, -1 when they're off. */
    textId: number;
}