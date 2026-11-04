import Hls from "hls.js";
import { QoESession } from "./qoe";
import { API_URL } from "./config";
import type { AbrAlgorithm } from "./abr";
import { ThroughputEstimator } from "./abr/ewma";

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
 * What the view is told about. Deliberately NOT hls.js's event shapes —
 * main.ts must never import Hls, or swapping in Shaka Player later would mean
 * rewriting the UI as well as this file.
 */
export type PlayerEvent =
    | { type: "manifest"; levels: LevelInfo[]; audioTracks: number }
    | { type: "switch"; index: number; height: number; bitrateKbps: number }
    | { type: "error"; detail: string; fatal: boolean };

export interface LevelInfo {
    index: number;
    height: number;
    bitrateKbps: number;
}

export interface PlayOptions {
    asset: Asset;
    url: string;
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

// The API owns where media lives — it builds hls_url from MEDIA_BASE_URL. The
// player asks rather than reconstructing the URL, so moving to a CDN is a
// server-side config change this file never learns about.
export function manifestURL(asset: Asset): string {
    if (!asset.hls_url) throw new Error(`no hls_url — status is "${asset.status}"`);
    return asset.hls_url.startsWith("http") ? asset.hls_url : API_URL + asset.hls_url;
}

export interface Playback {
    session: QoESession;
    /** -1 restores automatic selection. */
    setLevel(index: number): void;
    destroy(): void;
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
    const { asset, url, abr, networkProfile, onEvent = () => {} } = options;

    // The algorithm's name travels with the session so the beacon can say which
    // arm produced this row. A comparison you cannot attribute is not a
    // comparison. (Needs the second constructor parameter in qoe.ts.)
    const session = new QoESession({
        assetId: asset.asset_id,
        abrAlgorithm: abr.name,
        networkProfile,
    });

    const throughput = new ThroughputEstimator();
    let levels: LevelInfo[] = [];

    const on = <K extends keyof HTMLVideoElementEventMap>(type: K, fn: () => void) => {
        video.addEventListener(type, fn);
        return () => video.removeEventListener(type, fn);
    };

    // Playback events — these work on every path, including native HLS.
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

    let hls: Hls | null = null;

    if (Hls.isSupported()) {
        hls = new Hls();

        hls.on(Hls.Events.MANIFEST_PARSED, (_, data) => {
            // Assigned, not inlined: decide() reads this at every tick, long
            // after this handler has returned.
            levels = data.levels.map((l, index) => ({
                index,
                height: l.height,
                bitrateKbps: Math.round(l.bitrate / 1000),
            }));
            onEvent({
                type: "manifest",
                levels,
                // data.audioTracks, not hls.audioTracks: the property is filled
                // by hls.js's own listener on this same event, and listener
                // order is not guaranteed.
                audioTracks: data.audioTracks?.length ?? 0,
            });
        });

        hls.on(Hls.Events.LEVEL_SWITCHED, (_, data) => {
            const level = hls!.levels[data.level];
            const bitrateKbps = Math.round(level.bitrate / 1000);
            session.levelChanged(data.level, bitrateKbps);
            onEvent({ type: "switch", index: data.level, height: level.height, bitrateKbps });
        });

        hls.on(Hls.Events.ERROR, (_, data) => {
            onEvent({ type: "error", detail: `${data.type}/${data.details}`, fatal: data.fatal });
            if (data.fatal) session.failed(`${data.type}/${data.details}`);
        });

        // NEW — every completed fragment is one observation of the network.
        //
        // We compute our own estimate rather than reading hls.bandwidthEstimate:
        // borrowing their estimator would turn the milestone into a comparison
        // of two selection rules over one shared estimator, which is a
        // different and narrower experiment.
        hls.on(Hls.Events.FRAG_LOADED, (_, data) => {
            // Video media segments only. Audio segments (~96 KB) and init segments
            // (~1 KB) are small enough that their timing is mostly round-trip
            // latency, so they understate the link's speed.
            // frag.type is a hls.js enum; casting to string compares its value
            // without importing the enum.
            if ((data.frag.type as string) !== "main") return;
            if (data.frag.sn === "initSegment") return;

            const stats = data.frag.stats;
            const seconds = (stats.loading.end - stats.loading.start) / 1000;

            throughput.record(stats.total, seconds);
            session.recordDownload(stats.total, seconds);

            decide();
        });

        session.requestStarted();
        hls.loadSource(url);
        hls.attachMedia(video);
    } else {
        // Safari plays HLS natively. No level events exist here, so switch and
        // bitrate metrics stay empty — and your custom ABR does not run at all,
        // because there is nothing to write nextAutoLevel on.
        session.requestStarted();
        video.src = url;
    }

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

    // Declared with `function`, so it is hoisted and the FRAG_LOADED handler
    // above can call it even though it is written below.
    function decide(): void {
        if (!hls || levels.length === 0) return;

        // autoLevelEnabled is false once the viewer pins a rung in the
        // dropdown. An explicit choice outranks any algorithm — override it and
        // the manual control silently stops working, which is worse than having
        // no control at all.
        if (!hls.autoLevelEnabled) return;

        const next = abr.choose({
            levels,
            currentLevel: hls.currentLevel,
            bufferSeconds: bufferedAhead(),
            throughputKbps: throughput.kbps,
            segmentSeconds: SEGMENT_SECONDS,
            playbackRate: Math.abs(video.playbackRate) || 1,
        });

        // -1 means defer to hls.js. Writing -1 to nextAutoLevel would ALSO mean
        // auto, so this is harmless either way — but returning early leaves the
        // control arm genuinely untouched rather than coincidentally equivalent.
        if (next < 0) return;
        hls.nextAutoLevel = next;
    }

    void video.play().catch(() => {});

    // Dropped frames have no event; the only way to get them is to ask.
    const poll = window.setInterval(() => {
        const q = video.getVideoPlaybackQuality?.();
        if (q) session.recordDroppedFrames(q.droppedVideoFrames);
    }, 1000);

    // Fragment events only fire when something downloads. Buffer level changes
    // continuously as playback drains it, so a buffer-based algorithm needs its
    // own clock — otherwise it can only react when a segment arrives, which is
    // exactly the moment it is least able to help.
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
        setLevel(index: number) {
            if (hls) hls.currentLevel = index;
        },
        destroy() {
            window.clearInterval(poll);
            window.clearInterval(abrTick);   // or it ticks forever
            window.clearInterval(endWatch);
            off.forEach((f) => f());
            hls?.destroy();
        },
    };
}