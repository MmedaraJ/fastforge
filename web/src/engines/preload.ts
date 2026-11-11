import { readPresentation } from "./manifest";

/*
 * The next item in a feed, downloaded while the current one plays.
 *
 * A store of downloads keyed by URL. preloadStart() fills it with the files
 * the MSE engine asks for first when that item loads: the manifest (and, for
 * HLS, the media playlists), then the bottom rung's init segment and first
 * segment, and the same two for audio. Every fetch the engine makes looks
 * here before it goes to the network, and takes the entry out as it uses it.
 *
 * Only your MSE engine reads this store. hls.js and Shaka fetch through their
 * own loaders, so preloading does nothing for them.
 */

/**
 * Each download remembers which video it belongs to (that video's manifest
 * URL), so one video's files can be dropped while another's stay.
 */
interface Entry {
    owner: string;
    bytes: Promise<ArrayBuffer>;
}

const store = new Map<string, Entry>();

/** Start a download now and keep it. Asking for the same URL again reuses the first download. */
function keep(url: string, owner: string, signal: AbortSignal): Promise<ArrayBuffer> {
    const existing = store.get(url);
    if (existing) return existing.bytes;
    const bytes = fetch(url, { signal }).then((response) => {
        if (!response.ok) throw new Error(`preload: ${response.status} for ${url}`);
        return response.arrayBuffer();
    });
    // A failed preload must never fail the real load. Forget it, and the
    // engine fetches the file itself.
    bytes.catch(() => {
        if (store.get(url)?.bytes === bytes) store.delete(url);
    });
    store.set(url, { owner, bytes });
    return bytes;
}

const decoder = new TextDecoder();

/**
 * Download what the MSE engine needs for the first frame of `manifestUrl`.
 * Resolves with the media bytes kept, once everything has arrived.
 */
export async function preloadStart(manifestUrl: string, signal: AbortSignal): Promise<number> {
    const presentation = await readPresentation(manifestUrl, async (url) => decoder.decode(await keep(url, manifestUrl, signal)));

    // Rung 0, because that's where every opening lands: your algorithms open
    // at the bottom when there's no measurement yet, and engine-default stays
    // there.
    const rung = presentation.rungs[0];
    // The audio language the engine will start with: the default.
    const audio = presentation.audio.find((a) => a.isDefault) ?? presentation.audio[0];
    const urls = [
        rung?.playlist.initUri,
        rung?.playlist.segments[0]?.uri,
        audio?.playlist.initUri,
        audio?.playlist.segments[0]?.uri,
    ].filter((url): url is string => Boolean(url));

    const files = await Promise.all(urls.map((url) => keep(url, manifestUrl, signal)));
    return files.reduce((total, bytes) => total + bytes.byteLength, 0);
}

/**
 * The engine's first stop for every file: the preloaded download of `url` if
 * there is one, taken out of the store so it's used only once. Null if not.
 */
export function takePreloaded(url: string): Promise<ArrayBuffer> | null {
    const entry = store.get(url);
    store.delete(url);
    return entry?.bytes ?? null;
}

/** Forget one video's preloaded files: the feed has moved too far from it. */
export function dropPreloaded(manifestUrl: string): void {
    for (const [url, entry] of store) {
        if (entry.owner === manifestUrl) store.delete(url);
    }
}

/** Forget everything preloaded. */
export function clearPreloaded(): void {
    store.clear();
}