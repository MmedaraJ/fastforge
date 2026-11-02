import Hls from "hls.js";
import { QoESession } from "./qoe";
import { API_URL } from "./config";

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

export function play(
    video: HTMLVideoElement,
    asset: Asset,
    url: string,
    onEvent: (e: PlayerEvent) => void = () => {},
): Playback {
    const session = new QoESession(asset.asset_id);
  
    const on = <K extends keyof HTMLVideoElementEventMap>(type: K, fn: () => void) => {
        video.addEventListener(type, fn);
        return () => video.removeEventListener(type, fn);
    };
  
    // Playback events — these work on every path, including native HLS.
    const off = [
        on("playing", () => session.resumed()),
        on("waiting", () => {
            if (holdsEntireAsset(video)) return;
            session.stalled()
        }),
        // The browser fires seeking → waiting → seeked → playing, 
        // so if you don’t record the seek, the waiting that follows 
        // is indistinguishable from a genuine stall and every seek 
        // becomes a rebuffer in your data.
        on("seeking", () => session.seeking()),
        on("pause", () => session.paused()),
        on("ended", () => session.ended()),
    ];
  
    let hls: Hls | null = null;
  
    if (Hls.isSupported()) {
        hls = new Hls();
    
        hls.on(Hls.Events.MANIFEST_PARSED, (_, data) => {
            onEvent({
                type: "manifest",
                levels: data.levels.map((l, index) => ({
                    index,
                    height: l.height,
                    bitrateKbps: Math.round(l.bitrate / 1000),
                })),
                // data.audioTracks, not hls.audioTracks: the property is filled by
                // hls.js's own listener on this same event, and listener order is
                // not guaranteed.
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
    
        session.requestStarted();
        hls.loadSource(url);
        hls.attachMedia(video);
    } else {
        // Safari plays HLS natively. No level events exist here, so switch and
        // bitrate metrics stay empty — worth knowing before you compare Safari
        // sessions against Chrome ones and conclude something false.
        session.requestStarted();
        video.src = url;
    }
  
    void video.play().catch(() => {});
  
    // Dropped frames have no event; the only way to get them is to ask.
    const poll = window.setInterval(() => {
        const q = video.getVideoPlaybackQuality?.();
        if (q) session.recordDroppedFrames(q.droppedVideoFrames);
      }, 1000);
  
    return {
        setLevel(index: number) {
            if (hls) hls.currentLevel = index;
        },
        session,
        destroy() {
            window.clearInterval(poll);
            off.forEach((f) => f());
            hls?.destroy();
        },
    };
}