import type { AbrAlgorithm } from "./abr";
import { ThroughputEstimator } from "./abr/ewma";
import { API_URL } from "./config";
import { CAN_SELECT_LEVEL, createEngine, playsHlsNatively, resolveEngine } from "./engines";
import type { EngineName, LevelInfo, Protocol } from "./engines/types";
import { QoESession } from "./qoe";

// Re-exported so abr/types.ts, main.ts and experiment.ts keep importing from
// here. This file is the only door into the player; nothing outside it
// reaches into src/engines/.
export type { EngineName, LevelInfo, Protocol };
export { CAN_SELECT_LEVEL, playsHlsNatively };

export interface Rendition {
  height: number;
  width: number;
  bitrate_kbps: number;
  vmaf: number | null;
}

export interface Asset {
  asset_id: string;
  title: string;
  status: string;
  width: number | null;
  height: number | null;
  fps: number | null;
  duration_s: number | null;
  renditions: Rendition[];
  hls_url: string | null;
  dash_url: string | null;
}

/**
 * What the view is told about. Deliberately NOT any library's event shapes.
 * main.ts never imports hls.js or Shaka, which is why adding engines hasn't
 * meant rewriting the UI.
 */
export type PlayerEvent =
    | { type: "manifest"; levels: LevelInfo[]; audioTracks: number }
    | { type: "switch"; index: number; height: number; bitrateKbps: number }
    | { type: "error"; detail: string; fatal: boolean };

export interface PlayOptions {
    asset: Asset;
    url: string;
    /** The engine asked for. May be swapped for "native"; see resolveEngine. */
    engine: EngineName;
    protocol: Protocol;
    abr: AbrAlgorithm;
    /** Label for the network conditions, e.g. "2500k". Null if unlabelled. */
    networkProfile: string | null;
    onEvent?: (e: PlayerEvent) => void;
}

export async function fetchAsset(id: string): Promise<Asset> {
    const res = await fetch(`${API_URL}/assets/${id}`);
    if (!res.ok) throw new Error(`asset lookup failed: ${res.status}`);
    return res.json() as Promise<Asset>;
}

// The API owns where media lives: it builds both URLs from MEDIA_BASE_URL. The
// player asks rather than reconstructing them, so moving to a CDN is a
// server-side config change this file never learns about.
export function manifestURL(asset: Asset, protocol: Protocol): string {
    const path = protocol === "dash" ? asset.dash_url : asset.hls_url;
    if (!path) throw new Error(`no ${protocol} manifest; status is "${asset.status}"`);
    return path.startsWith("http") ? path : API_URL + path;
}

export interface Playback {
    session: QoESession;
    /** The engine actually running, which can differ from the one asked for. */
    engine: EngineName;
    /** False when the engine picks renditions itself and can't be overruled. */
    canSelectLevel: boolean;
    /** -1 restores automatic selection. */
    setLevel(index: number): void;
    destroy(): Promise<void>;
}

// Must match ladder.SegmentSeconds on the server. BOLA reasons in segments
// rather than seconds, so a wrong value here silently rescales every decision
// it makes — and nothing fails loudly enough to point at this line.
const SEGMENT_SECONDS = 6;

/**
 * Is every byte that exists already buffered?
 *
 * A stall is only a rebuffer if the player wants data it does not have. At the
 * end of an asset there is nothing left to want — and browsers routinely fire
 * 'waiting' in the gap before 'ended', which would otherwise add one phantom
 * rebuffer to every completed session. That is a bias, not noise: it inflates
 * every number in the same direction every time.
 *
 * Note this does NOT suppress genuine end-of-stream stalls. If the last
 * segment has not arrived, buffered.end() falls short of duration and the
 * stall is counted.
 */
function holdsEntireAsset(video: HTMLVideoElement): boolean {
    const { duration, buffered } = video;
    if (!Number.isFinite(duration) || buffered.length === 0) return false;
    return buffered.end(buffered.length - 1) >= duration - 0.5;
}

/**
 * Has playback reached the end of the content?
 *
 * You'd expect the browser's `ended` event to answer this, but it isn't
 * reliable. The browser fires `ended` only when the playhead reaches the
 * media's full duration, and with Media Source Extensions that requires the
 * player to have declared the stream complete by calling
 * MediaSource.endOfStream(). If the last moments never become playable (this
 * stream ends with a one-frame, 0.042-second video segment), the playhead
 * stops just short, the picture freezes on the last frame, and no event fires.
 *
 * So check the conditions directly: everything is buffered, and less than
 * half a second of the declared duration remains.
 */
function reachedEnd(video: HTMLVideoElement): boolean {
    return holdsEntireAsset(video) && video.duration - video.currentTime < 0.5;
}

export function play(video: HTMLVideoElement, options: PlayOptions): Playback {
    const { asset, url, protocol, abr, networkProfile, onEvent = () => {} } = options;

    // Settle which engine really runs before anything else, because the rest
    // depends on it: whether your ABR can run, and what the session records.
    const engineName = resolveEngine(options.engine, protocol, video);
    const canSelectLevel = CAN_SELECT_LEVEL[engineName];
    const ownAbr = canSelectLevel && !abr.deferToEngine;

    const session = new QoESession({
        assetId: asset.asset_id,
        // Record who actually chose the renditions. On an engine that can't be
        // overruled, that was the engine, whatever the ABR dropdown said.
        // Recording the dropdown would file sessions your algorithm never
        // touched under its name. (The old native fallback did exactly that:
        // it recorded abr.name, then never ran the algorithm.)
        abrAlgorithm: ownAbr ? abr.name : "engine-default",
        networkProfile,
        // The engine that ran, not the one requested, for the same reason.
        engine: engineName,
        protocol,
    });

    const throughput = new ThroughputEstimator();
    let levels: LevelInfo[] = [];
    // Tracked here rather than asked of the engine: every engine reports
    // switches through onSwitch, but they don't all have a "current level"
    // property to read.
    let currentLevel = -1;
    // What your algorithm last asked for. Not the same as currentLevel: a
    // request only reaches the screen once its segment plays, so the two can
    // disagree for up to a buffer's worth of seconds.
    let requestedLevel = -1;

    const on =<K extends keyof HTMLVideoElementEventMap>(type: K, fn: () => void) => {
        video.addEventListener(type, fn);
        return () => video.removeEventListener(type, fn);
    };

    // Playback events: standard <video> events, the same for every engine,
    // native included. That's why they stay in this file.
    const off = [
        on("playing", () => session.resumed()),
        on("waiting", () => {
            // At the end of the content there's nothing left to wait for, so
            // this isn't a stall: the session is over. Closing it here, rather
            // than waiting for an `ended` event that may never come, stops the
            // frozen last frame from being counted as playing time.
            if (reachedEnd(video)) {
                session.ended();
                return;
            }
            session.stalled();
        }),
        // The browser fires seeking → waiting → seeked → playing, so without
        // recording the seek, the waiting that follows is indistinguishable
        // from a genuine stall and every seek becomes a rebuffer in your data.
        on("seeking", () => session.seeking()),
        on("pause", () => session.paused()),
        on("ended", () => session.ended()),
    ];

    const onVisibility = () => {
        if (document.visibilityState === "hidden") session.hiddenBeforeStart();
    };
    document.addEventListener("visibilitychange", onVisibility);
    off.push(() => document.removeEventListener("visibilitychange", onVisibility));

    // Seconds of media ahead of the playhead. Buffer-based algorithms are
    // entirely a function of this number, so it is worth being exact: find the
    // buffered range CONTAINING the playhead, not simply the last one. A gap
    // left by a seek would otherwise report runway that cannot be played.
    function bufferedAhead(): number {
        const ranges = video.buffered;
        for (let i = 0; i < ranges.length; i++) {
            if (video.currentTime >= ranges.start(i) && video.currentTime <= ranges.end(i)) {
                return ranges.end(i) - video.currentTime;
            }
        }
        return 0;
    }

    // decide() and the callbacks below use `engine`, which is declared
    // further down. That's safe only because none of them runs until later
    // (after a download, on the 500 ms tick, or once the manifest is read), by
    // which time `engine` exists. Reading a `const` before its line has run
    // throws a ReferenceError.
    function decide(): void {
        if (!ownAbr || levels.length === 0) return;

        // autoEnabled is false once the viewer pins a rung in the dropdown. An
        // explicit choice outranks any algorithm — override it and the manual
        // control silently stops working, which is worse than having no
        // control at all.
        if (!engine.autoEnabled) return;

        const next = abr.choose({
            levels,
            currentLevel,
            requestedLevel,
            bufferSeconds: bufferedAhead(),
            throughputKbps: throughput.kbps,
            segmentSeconds: SEGMENT_SECONDS,
            playbackRate: Math.abs(video.playbackRate) || 1,
        });
        if (next < 0) return;
        requestedLevel = next;
        engine.requestLevel(next);
    }

    // Delivery events: each engine translates its own library's events into
    // these four callbacks. This object is the only thing player.ts knows
    // about engines.
    const engine = createEngine(engineName, video, {
        ownAbr,

        onManifest(found, audioTracks) {
            // Assigned, not inlined: decide() reads this at every tick, long
            // after this callback has returned.
            levels = found;
            onEvent({ type: "manifest", levels, audioTracks });

            // The opening level. When your algorithm is in charge it makes
            // this choice too, with what's known at this moment: an empty
            // buffer and no measurement. Both of yours answer 0 then ("start
            // at the bottom"). Asking here is what makes the opening the same
            // on every engine. In Milestone 9 nothing asked, so the first
            // segment was whatever hls.js chose. -1 lets the engine choose.
            const opening = ownAbr
                ? abr.choose({
                      levels,
                      currentLevel: -1,
                      requestedLevel: -1,
                      bufferSeconds: 0,
                      throughputKbps: throughput.kbps,
                      segmentSeconds: SEGMENT_SECONDS,
                      playbackRate: Math.abs(video.playbackRate) || 1,
                  })
                : -1;
            if (opening >= 0) requestedLevel = opening;

            // Required by the Engine contract: start() is called before this
            // callback returns. See EngineCallbacks.onManifest for why.
            engine.start(opening);
        },

        onSwitch(index) {
            currentLevel = index;
            const level = levels[index];
            if (!level) return;
            session.levelChanged(index, level.bitrateKbps);
            onEvent({ type: "switch", index, height: level.height, bitrateKbps: level.bitrateKbps });
        },

        // Every completed video segment is one observation of the network. We
        // keep our own estimate rather than borrowing an engine's: that keeps
        // the comparison about selection rules, over one shared estimator.
        onDownload(bytes, seconds) {
            throughput.record(bytes, seconds);
            session.recordDownload(bytes, seconds);
            decide();
        },

        onError(detail, fatal) {
            onEvent({ type: "error", detail, fatal });
            if (fatal) session.failed(detail);
        },
    });

    // Set by destroy(). Anything that finishes after that belongs to a
    // session that's already over, and must not touch the <video>, which by
    // then belongs to the next session.
    let destroyed = false;

    session.requestStarted();
    engine.load(url).then(
        // Ask to play only once the engine has given the <video> a source.
        // hls.js attaches immediately, so calling play() straight away used to
        // work. Shaka attaches asynchronously: when its source arrives, the
        // browser treats it as a new load, cancels the pending play() ("The
        // play() request was interrupted by a new load request"), and the
        // video sits paused.
        () => {
            if (destroyed) return;
            video.play().catch((error: unknown) => {
                if (destroyed) return;
                // Usually the browser's autoplay policy. Not fatal, since the
                // viewer can press play, but no longer swallowed silently.
                const detail = error instanceof Error ? error.message : String(error);
                onEvent({ type: "error", detail: `play() refused: ${detail}`, fatal: false });
            });
        },
        (error: unknown) => {
            // Tearing an engine down mid-load makes its load fail (Shaka calls
            // it LOAD_INTERRUPTED). That's not a playback failure.
            if (destroyed) return;
            const detail = error instanceof Error ? error.message : String(error);
            onEvent({ type: "error", detail, fatal: true });
            session.failed(detail);
        },
    );

    // Dropped frames have no event; the only way to get them is to ask.
    const poll = window.setInterval(() => {
        const q = video.getVideoPlaybackQuality?.();
        if (q) session.recordDroppedFrames(q.droppedVideoFrames);
    }, 1000);

    // Download callbacks only fire when something downloads. Buffer level
    // changes continuously as playback drains it, so a buffer-based algorithm
    // needs its own clock — otherwise it can only react when a segment
    // arrives, which is exactly the moment it is least able to help.
    const abrTick = window.setInterval(decide, 500);

    // `waiting` isn't guaranteed to fire at the end either, so also check on a
    // timer: if the playhead hasn't moved for half a second, the viewer hasn't
    // paused, and the content is over, end the session.
    let lastPosition = -1;
    const endWatch = window.setInterval(() => {
        const frozen = !video.paused && video.currentTime === lastPosition;
        lastPosition = video.currentTime;
        if (frozen && !session.hasEnded && reachedEnd(video)) session.ended();
    }, 500);

    return {
        session,
        engine: engineName,
        canSelectLevel,
        setLevel: (index) => engine.setLevel(index),
        async destroy() {
            destroyed = true;
            window.clearInterval(poll);
            window.clearInterval(abrTick);   // or it ticks forever
            window.clearInterval(endWatch);
            off.forEach((f) => f());
            // Awaited: the next engine must not attach to this <video> until
            // this one has let go of it.
            await engine.destroy();
        },
    };
}
