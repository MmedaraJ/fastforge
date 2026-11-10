import { parseMpd } from "./dash/mpd";
import { parseMaster, parseMedia } from "./hls/playlist";
import type { Presentation } from "./presentation";

/**
 * Reads a manifest, HLS or DASH, into the Presentation the MSE engine plays.
 *
 * This lived inside mse.ts until Milestone 12. The preloader needs the same
 * answer the engine will get, so that it fetches exactly the files the engine
 * is about to ask for, and sharing one function is what guarantees that.
 *
 * `fetchText` is a parameter for the same reason. The engine passes its own,
 * which looks in the preload store first and stops when a load is abandoned;
 * the preloader passes one that keeps what it downloads.
 */
export async function readPresentation(
    url: string,
    fetchText: (url: string) => Promise<string>,
): Promise<Presentation> {
    // Both formats say what they are in their first bytes: an HLS playlist
    // must begin with #EXTM3U (RFC 8216), and an MPD is XML whose root is
    // <MPD>. Reading the content, not the URL's extension, also works for
    // signed URLs that end in a query string.
    const text = (await fetchText(url)).trimStart();
    if (text.startsWith("#EXTM3U")) return fromHls(text, url, fetchText);
    if (text.includes("<MPD")) return parseMpd(text, url);
    throw new Error("mse: the manifest is neither HLS (#EXTM3U) nor DASH (<MPD>)");
}

/**
 * HLS: the master playlist names a media playlist per rung, so those are
 * fetched too. A DASH MPD already lists every segment, so parseMpd() needs no
 * further requests: one round trip fewer before the first segment.
 */
async function fromHls(
    text: string,
    url: string,
    fetchText: (url: string) => Promise<string>,
): Promise<Presentation> {
    const master = parseMaster(text, url);

    // The audio rendition the variants point at. Your stream has one.
    const group = master.variants[0]?.audioGroup ?? null;
    const audio = master.audio.find((a) => a.groupId === group) ?? null;

    // Every media playlist, fetched up front: four small text files for your
    // ladder. hls.js loads a level's playlist only when it first needs it;
    // for VOD that saves little.
    const [videoPlaylists, audioPlaylist] = await Promise.all([
        Promise.all(master.variants.map(async (v) => parseMedia(await fetchText(v.uri), v.uri))),
        audio ? fetchText(audio.uri).then((body) => parseMedia(body, audio.uri)) : Promise.resolve(null),
    ]);

    return {
        rungs: master.variants.map((v, i) => ({ bandwidth: v.bandwidth, height: v.height, codecs: v.codecs, playlist: videoPlaylists[i] })),
        audio: audioPlaylist,
        audioTracks: master.audio.length,
    };
}