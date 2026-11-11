/**
 * Just enough HLS to play the streams your own pipeline produces: 
 * the master playlist's variants, audio languages and subtitle languages, 
 * and each media playlist's init segment and segments.
 *
 * Deliberately not a general parser. No live playlists, byte ranges,
 * encryption, discontinuities or I-frame playlists: your packager emits none
 * of them, and code for cases you can't test is code you can't trust.
 */

export interface Variant {
    /** Absolute URL of this variant's media playlist. */
    uri: string;
    /** Peak bits per second, from BANDWIDTH. hls.js reports the same value. */
    bandwidth: number;
    height: number;
    /** From CODECS, e.g. ["avc1.640028", "mp4a.40.2"]. */
    codecs: string[];
    /** GROUP-ID of the audio this variant plays with, or null. */
    audioGroup: string | null;
    /** GROUP-ID of the subtitles that go with this variant, or null. */
    subtitleGroup: string | null;
}

/** An EXT-X-MEDIA line: one audio language or one subtitle language. */
export interface Rendition {
    uri: string;
    groupId: string;
    name: string;
    /** LANGUAGE: a BCP 47 tag such as "en" or "vi"; "" if absent. */
    language: string;
    /** DEFAULT=YES: play this one unless the viewer chooses otherwise. */
    isDefault: boolean;
    /** FORCED=YES, subtitles only: show even when subtitles are off. */
    forced: boolean;
}

export interface MasterPlaylist {
    /** Lowest bandwidth first, the order every engine reports levels in. */
    variants: Variant[];
    audio: Rendition[];
    subtitles: Rendition[];
}

export interface Segment {
    uri: string;
    /** Seconds from the start of the stream: the sum of earlier EXTINFs. */
    start: number;
    duration: number;
}

export interface MediaPlaylist {
    /** The #EXT-X-MAP init segment: decoder setup, sent once per rendition. */
    initUri: string | null;
    segments: Segment[];
    duration: number;
    /** #EXT-X-ENDLIST: the playlist is finished (VOD). */
    ended: boolean;
}

/**
 * An HLS attribute list: KEY=value pairs separated by commas, where a quoted
 * value may itself contain commas (CODECS="avc1.640028,mp4a.40.2"). The regex
 * consumes each whole value, quoted or not, so the next match starts at the
 * next key: AVERAGE-BANDWIDTH can't be mistaken for BANDWIDTH.
 */
function attributes(line: string): Map<string, string> {
    const list = line.slice(line.indexOf(":") + 1);
    const out = new Map<string, string>();
    for (const m of list.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)) {
        const value = m[2];
        out.set(m[1], value.startsWith('"') ? value.slice(1, -1) : value);
    }
    return out;
}

/** URIs in a playlist are relative to the playlist's own URL. */
function resolve(uri: string, base: string): string {
    return new URL(uri, base).href;
}

export function parseMaster(text: string, baseUrl: string): MasterPlaylist {
    const lines = text.split(/\r?\n/).map((line) => line.trim());
    const variants: Variant[] = [];
    const audio: Rendition[] = [];
    const subtitles: Rendition[] = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        if (line.startsWith("#EXT-X-MEDIA:")) {
            const a = attributes(line);
            const uri = a.get("URI");
            // An audio rendition without a URI is the audio muxed into the
            // variants themselves. Your packager never writes one.
            if (!uri) continue;
            const rendition: Rendition = {
                uri: resolve(uri, baseUrl),
                groupId: a.get("GROUP-ID") ?? "",
                name: a.get("NAME") ?? "",
                language: a.get("LANGUAGE") ?? "",
                isDefault: a.get("DEFAULT") === "YES",
                forced: a.get("FORCED") === "YES",
            };
            if (a.get("TYPE") === "AUDIO") audio.push(rendition);
            if (a.get("TYPE") === "SUBTITLES") subtitles.push(rendition);
            continue;
        }

        if (!line.startsWith("#EXT-X-STREAM-INF:")) continue;

        // A variant is its tag line plus the next line that isn't a tag or
        // blank: the URI of its media playlist.
        const a = attributes(line);
        let j = i + 1;
        while (j < lines.length && (lines[j] === "" || lines[j].startsWith("#"))) j++;
        if (j >= lines.length) break;

        variants.push({
            uri: resolve(lines[j], baseUrl),
            bandwidth: Number(a.get("BANDWIDTH") ?? 0),
            height: Number(a.get("RESOLUTION")?.split("x")[1] ?? 0),
            codecs: (a.get("CODECS") ?? "").split(",").map((c) => c.trim()).filter(Boolean),
            audioGroup: a.get("AUDIO") ?? null,
            subtitleGroup: a.get("SUBTITLES") ?? null,
        });
        i = j;
    }

    variants.sort((x, y) => x.bandwidth - y.bandwidth);
    return { variants, audio, subtitles };
}

export function parseMedia(text: string, baseUrl: string): MediaPlaylist {
    let initUri: string | null = null;
    const segments: Segment[] = [];
    let duration: number | null = null; // from the #EXTINF waiting for its URI
    let t = 0;
    let ended = false;

    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (line === "") continue;

        if (line.startsWith("#EXT-X-MAP:")) {
            const uri = attributes(line).get("URI");
            if (uri) initUri = resolve(uri, baseUrl);
        } else if (line.startsWith("#EXTINF:")) {
            // "#EXTINF:6.000," -- parseFloat stops at the comma.
            duration = parseFloat(line.slice("#EXTINF:".length));
        } else if (line === "#EXT-X-ENDLIST") {
            ended = true;
        } else if (!line.startsWith("#") && duration !== null) {
            segments.push({ uri: resolve(line, baseUrl), start: t, duration });
            t += duration;
            duration = null;
        }
    }

    return { initUri, segments, duration: t, ended };
}