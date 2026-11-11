import type { MediaPlaylist, Segment } from "../hls/playlist";
import type { AudioOption, Presentation, Rung, SubtitleOption } from "../presentation";

/*
 * Just enough DASH to play what your packager writes: one Period; 
 * a video AdaptationSet, one per audio language and one per subtitle language; 
 * and in each Representation a SegmentTemplate with a SegmentTimeline and $Number$ 
 * in its media pattern.
 *
 * These are refused with an error that names them, rather than played
 * wrong: live MPDs, several Periods, SegmentBase or SegmentList,
 * presentationTimeOffset, open-ended repeats. Your packager writes none of
 * them since --generate_static_live_mpd; before that flag, every MPD it wrote
 * said type="dynamic", and Shaka started your clip near its end because of it.
 * Two things aren't looked at, because your packager never writes them:
 * <BaseURL>, and the template identifiers $RepresentationID$ and $Bandwidth$.
 */

export function parseMpd(text: string, url: string): Presentation {
    const doc = new DOMParser().parseFromString(text, "application/xml");
    if (doc.getElementsByTagName("parsererror").length > 0) throw new Error("mse: the MPD isn't valid XML");
    const mpd = doc.documentElement;
    if (mpd.localName !== "MPD") throw new Error("mse: the manifest's root element isn't <MPD>");

    // type="dynamic" means live: segments appear over time and the player
    // starts near the live edge. A VOD engine must not pretend otherwise.
    if (mpd.getAttribute("type") === "dynamic") throw new Error('mse: this MPD is live (type="dynamic"); package the asset as VOD');

    const periods = children(mpd, "Period");
    if (periods.length !== 1) throw new Error(`mse: the MPD has ${periods.length} Periods; one is supported`);
    const sets = children(periods[0], "AdaptationSet");

    const videoSet = sets.find((set) => kindOf(set) === "video");
    if (!videoSet) throw new Error("mse: the MPD has no video AdaptationSet");
    
    // One AdaptationSet per audio language. lang says which language, and a
    // Role of "main" marks the default: your packager writes it on the
    // language you name with --default_language. Each set holds one
    // Representation, because your audio has one bitrate.
    const audioSets = sets
        .filter((set) => kindOf(set) === "audio")
        .map((set) => ({ set, rep: children(set, "Representation")[0] }))
        .filter((a): a is { set: Element; rep: Element } => a.rep !== undefined);
    const audio: AudioOption[] = audioSets.map(({ set, rep }) => {
        const language = set.getAttribute("lang") ?? "";
        return { language, label: labelOf(set) ?? language, isDefault: hasRole(set, "main"), playlist: segmentsOf(rep, url) };
    });
    // The largest audio bitrate, which is what your packager's HLS BANDWIDTH
    // counts for a variant whose audio group holds several languages.
    const audioBandwidth = Math.max(0, ...audioSets.map(({ rep }) => Number(rep.getAttribute("bandwidth") ?? 0)));
    const audioCodec = audioSets[0] ? inherited(audioSets[0].rep, "codecs") : null;

    // Subtitles: one AdaptationSet per language, WebVTT files listed by the
    // same kind of SegmentTemplate as media. IMSC/TTML subtitles (a mimeType
    // of application/ttml+xml, or stpp inside MP4) aren't read here.
    const subtitles: SubtitleOption[] = sets
        .filter((set) => kindOf(set) === "text")
        .flatMap((set) => {
            const rep = children(set, "Representation")[0];
            if (!rep || inherited(rep, "mimeType") !== "text/vtt") return [];
            const language = set.getAttribute("lang") ?? "";
            return [{
                language,
                label: labelOf(set) ?? language,
                isDefault: hasRole(set, "main"),
                forced: hasRole(set, "forced-subtitle"),
                playlist: segmentsOf(rep, url),
            }];
        });

    const rungs: Rung[] = children(videoSet, "Representation").map((rep) => ({
        // Video and audio are listed separately here; adding them gives what
        // HLS's BANDWIDTH says for the same rung, and what Shaka reports for
        // DASH. For your 480p: 1416652 + 130333 = 1546985 bits per second.
        bandwidth: Number(rep.getAttribute("bandwidth") ?? 0) + audioBandwidth,
        height: Number(inherited(rep, "height") ?? 0),
        codecs: [inherited(rep, "codecs"), audioCodec].filter((c): c is string => Boolean(c)),
        playlist: segmentsOf(rep, url),
    }));
    rungs.sort((x, y) => x.bandwidth - y.bandwidth);

    return { rungs, audio, subtitles };
}

/**
 * One Representation's init segment and segments: the DASH counterpart of
 * parseMedia().
 *
 * Each <S> is a run of segments: t = start, d = duration, r = how many MORE
 * segments of the same duration follow. Times are counted in ticks of the
 * timescale: 12288 per second for your video (24 fps × 512 ticks per frame)
 * and 48000 for your audio (its sample rate). So every boundary is an exact
 * integer, where HLS writes a decimal rounded to the millisecond.
 *
 *   <S t="0" d="73728" r="4"/>   five segments of 73728 / 12288 = 6.000 s
 *   <S t="368640" d="512"/>      one of 512 / 12288 = 0.042 s, starting at 30 s
 */
function segmentsOf(rep: Element, mpdUrl: string): MediaPlaylist {
    const template = children(rep, "SegmentTemplate")[0];
    if (!template) throw new Error(`mse: Representation ${rep.getAttribute("id")} has no SegmentTemplate`);
    const timeline = children(template, "SegmentTimeline")[0];
    if (!timeline) throw new Error("mse: a SegmentTemplate without a SegmentTimeline isn't supported");
    if (Number(template.getAttribute("presentationTimeOffset") ?? 0) !== 0) {
        throw new Error("mse: presentationTimeOffset isn't supported");
    }

    const timescale = Number(template.getAttribute("timescale") ?? 1);
    const media = template.getAttribute("media");
    if (!media) throw new Error("mse: a SegmentTemplate has no media pattern");
    const init = template.getAttribute("initialization");

    const segments: Segment[] = [];
    let number = Number(template.getAttribute("startNumber") ?? 1);
    let t = 0;
    for (const s of children(timeline, "S")) {
        // t is optional after the first <S>: without it, this run starts
        // where the previous one ended.
        if (s.hasAttribute("t")) t = Number(s.getAttribute("t"));
        const d = Number(s.getAttribute("d"));
        const r = Number(s.getAttribute("r") ?? 0);
        if (r < 0) throw new Error("mse: an open-ended repeat (r=-1) isn't supported");
        for (let k = 0; k <= r; k++) {
            // Dividing the integer tick count, rather than adding up
            // rounded durations, keeps every start exact however long the
            // stream is.
            segments.push({ uri: resolve(fill(media, number, t), mpdUrl), start: t / timescale, duration: d / timescale });
            t += d;
            number++;
        }
    }

    const last = segments[segments.length - 1];
    return {
        initUri: init ? resolve(init, mpdUrl) : null,
        segments,
        duration: last ? last.start + last.duration : 0,
        ended: true, // a static MPD is complete: everything is listed
    };
}

/** "480p/$Number$.m4s" → "480p/3.m4s". Also $Time$, and a width such as $Number%05d$. */
function fill(pattern: string, number: number, time: number): string {
    return pattern.replace(/\$(Number|Time)(?:%0(\d+)d)?\$/g, (_match, name: string, width?: string) => {
        const value = String(name === "Number" ? number : time);
        return width ? value.padStart(Number(width), "0") : value;
    });
}

/** "video" or "audio": contentType if present, else the top half of mimeType. */
function kindOf(set: Element): string {
    const type = set.getAttribute("contentType");
    if (type) return type;
    const mime = set.getAttribute("mimeType") ?? children(set, "Representation")[0]?.getAttribute("mimeType") ?? "";
    return mime.split("/")[0];
}

/** Does this AdaptationSet carry <Role schemeIdUri="urn:mpeg:dash:role:2011" value="…">? */
function hasRole(set: Element, value: string): boolean {
    return children(set, "Role").some(
        (role) => role.getAttribute("schemeIdUri") === "urn:mpeg:dash:role:2011" && role.getAttribute("value") === value,
    );
}

/** A <Label> child, DASH's counterpart of HLS's NAME: your packager writes it from each stream's dash_label. */
function labelOf(set: Element): string | null {
    return children(set, "Label")[0]?.textContent?.trim() || null;
}

/** DASH lets an attribute sit on the Representation or on its AdaptationSet. */
function inherited(rep: Element, name: string): string | null {
    return rep.getAttribute(name) ?? rep.parentElement?.getAttribute(name) ?? null;
}

/** Direct children by element name, whatever XML namespace prefix the file uses. */
function children(parent: Element, name: string): Element[] {
    return Array.from(parent.children).filter((child) => child.localName === name);
}

/** Paths in an MPD are relative to the MPD's own URL. Your packager writes no <BaseURL>. */
function resolve(uri: string, base: string): string {
    return new URL(uri, base).href;
}