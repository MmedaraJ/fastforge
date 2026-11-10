import { HlsJsEngine } from "./hlsjs";
import { NativeEngine } from "./native";
import { ShakaEngine } from "./shaka";
import { MseEngine } from "./mse";
import type { Engine, EngineName, EngineOptions, Protocol } from "./types";

/**
 * Can the page tell this engine which rendition to play?
 *
 * This is a fact about the engine, not about one playback, and player.ts
 * needs it BEFORE any engine exists: the answer decides whether your ABR runs
 * at all, and Shaka has to be constructed differently depending on it. So it
 * lives in a table rather than on the Engine interface.
 *
 * Typing it as Record<EngineName, boolean> makes the compiler demand an entry
 * for every engine. Add a fourth name to EngineName and this stops compiling
 * until you've answered the question for it.
 */
export const CAN_SELECT_LEVEL: Record<EngineName, boolean> = {
    hlsjs: true,
    shaka: true,
    native: false,
    mse: true,
};

/** Media Source Extensions, including Safari's ManagedMediaSource. */
function hasMediaSource(): boolean {
    // Read through a widened type: ManagedMediaSource isn't in every browser,
    // so TypeScript's DOM types may not declare it.
    const scope = globalThis as { ManagedMediaSource?: unknown; MediaSource?: unknown };
    return Boolean(scope.ManagedMediaSource || scope.MediaSource);
}

/** Can this browser play an HLS playlist by itself, from video.src? */
export function playsHlsNatively(video: HTMLVideoElement): boolean {
    // canPlayType answers "", "maybe" or "probably", never a plain yes: the
    // browser can't know for certain until it tries the actual stream.
    return video.canPlayType("application/vnd.apple.mpegurl") !== "";
}

/**
 * Which engine will actually run, given the one that was asked for.
 *
 * MSE first; native only when MSE is missing. The order matters. "Can this
 * browser play HLS by itself?" used to mean "this is Safari", so plenty of
 * players asked it first. Since late 2025 desktop Chrome can too, so a player
 * that prefers native now hands Chrome users to Chrome's brand-new HLS player
 * instead of hls.js.
 */
export function resolveEngine(requested: EngineName, protocol: Protocol, video: HTMLVideoElement): EngineName {
    if (hasMediaSource()) return requested;
    if (protocol === "hls" && playsHlsNatively(video)) return "native";

    // Nothing here can play this (DASH on an old iPhone, for example). Keep
    // the requested engine: it fails with its own error, and the session
    // records that failure, so you can see how often it happens.
    return requested;
}

export function createEngine(name: EngineName, video: HTMLVideoElement, options: EngineOptions): Engine {
    switch (name) {
        case "hlsjs":
            return new HlsJsEngine(video, options);
        case "shaka":
            return new ShakaEngine(video, options);
        case "native":
            return new NativeEngine(video, options);
        case "mse":
            return new MseEngine(video, options);
    }
}
