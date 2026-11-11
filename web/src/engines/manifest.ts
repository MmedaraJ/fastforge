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

    // The audio and subtitle groups the variants point at. Every variant of
    // your ladder points at the same two, so the first variant's will do.
    const audioGroup = master.variants[0]?.audioGroup ?? null;
    const subtitleGroup = master.variants[0]?.subtitleGroup ?? null;
    const audio = master.audio.filter((a) => a.groupId === audioGroup);
    const subtitles = master.subtitles.filter((s) => s.groupId === subtitleGroup);

    // Every media playlist, fetched up front: for your ladder, three video,
    // two audio and two subtitle playlists, all small text files, all at
    // once. hls.js loads a playlist only when it first needs it; for VOD
    // that saves little.
    const read = async (uri: string) => parseMedia(await fetchText(uri), uri);
    const [videoPlaylists, audioPlaylists, subtitlePlaylists] = await Promise.all([
        Promise.all(master.variants.map((v) => read(v.uri))),
        Promise.all(audio.map((a) => read(a.uri))),
        Promise.all(subtitles.map((s) => read(s.uri))),
    ]);

    return {
        rungs: master.variants.map((v, i) => ({ bandwidth: v.bandwidth, height: v.height, codecs: v.codecs, playlist: videoPlaylists[i] })),
        audio: audio.map((a, i) => ({ language: a.language, label: a.name || a.language, isDefault: a.isDefault, playlist: audioPlaylists[i] })),
        subtitles: subtitles.map((s, i) => ({
            language: s.language,
            label: s.name || s.language,
            isDefault: s.isDefault,
            forced: s.forced,
            playlist: subtitlePlaylists[i],
        })),
    };
}