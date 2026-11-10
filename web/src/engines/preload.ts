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

const store = new Map<string, Promise<ArrayBuffer>>();

/** Start a download now and keep it. Asking for the same URL again reuses the first download. */
function keep(url: string, signal: AbortSignal): Promise<ArrayBuffer> {
    let entry = store.get(url);
    if (!entry) {
        entry = fetch(url, { signal }).then((response) => {
            if (!response.ok) throw new Error(`preload: ${response.status} for ${url}`);
            return response.arrayBuffer();
        });
        // A failed preload must never fail the real load. Forget it, and the
        // engine fetches the file itself.
        entry.catch(() => store.delete(url));
        store.set(url, entry);
    }
    return entry;
}

const decoder = new TextDecoder();

/**
 * Download what the MSE engine needs for the first frame of `manifestUrl`.
 * Resolves with the media bytes kept, once everything has arrived.
 */
export async function preloadStart(manifestUrl: string, signal: AbortSignal): Promise<number> {
    const presentation = await readPresentation(manifestUrl, async (url) => decoder.decode(await keep(url, signal)));

    // Rung 0, because that's where every opening lands: your algorithms open
    // at the bottom when there's no measurement yet, and engine-default stays
    // there.
    const rung = presentation.rungs[0];
    const urls = [
        rung?.playlist.initUri,
        rung?.playlist.segments[0]?.uri,
        presentation.audio?.initUri,
        presentation.audio?.segments[0]?.uri,
    ].filter((url): url is string => Boolean(url));

    const files = await Promise.all(urls.map((url) => keep(url, signal)));
    return files.reduce((total, bytes) => total + bytes.byteLength, 0);
}

/**
 * The engine's first stop for every file: the preloaded download of `url` if
 * there is one, taken out of the store so it's used only once. Null if not.
 */
export function takePreloaded(url: string): Promise<ArrayBuffer> | null {
    const entry = store.get(url) ?? null;
    store.delete(url);
    return entry;
}

/** Forget everything preloaded: the feed moved somewhere the preload didn't expect. */
export function clearPreloaded(): void {
    store.clear();
}