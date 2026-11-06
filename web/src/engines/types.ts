/**
 * The contract every playback engine fulfils. player.ts depends only on this
 * file; nothing outside src/engines/ may import hls.js or Shaka.
 */

export type EngineName = "hlsjs" | "shaka" | "native";
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
}

export interface EngineOptions extends EngineCallbacks {
    /**
     * True when your own ABR algorithm chooses renditions. False means the
     * engine's built-in ABR does, which is the control arm of experiments.
     */
    ownAbr: boolean;
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

    /**
     * Asynchronous because detaching a MediaSource from a <video> element is.
     * Attaching a new engine to the same element before the old one has let go
     * can leave the two fighting over it.
     */
    destroy(): Promise<void>;
}