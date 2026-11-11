/*
 * WebVTT, read into cues: when each line of text shows, and for how long.
 *
 * The browser has a full WebVTT parser, but only behind <track src="…">,
 * which takes one whole file. HLS and DASH deliver subtitles as a series of
 * short files, one per segment, so players read them themselves (hls.js has
 * its own, in vttparser.ts) and hand the browser finished cues.
 *
 * A file looks like this (W3C WebVTT):
 *
 *   WEBVTT                                       required first line
 *   X-TIMESTAMP-MAP=MPEGTS:900000,LOCAL:00:00:00.000   optional header lines
 *                                                a blank line ends every block
 *   3                                            optional cue identifier
 *   00:00:06.000 --> 00:00:09.000 align:center   timing, then settings
 *   English 3: 6–9 s                             the text, one or more lines
 */

export interface Cue {
    /** Seconds on the media timeline, where the video's timestamps live. */
    start: number;
    end: number;
    text: string;
    /** The settings after the timing: align → center, line → 85%, and so on. */
    settings: Map<string, string>;
}

/** hh:mm:ss.ttt, where the hours are optional: 01:02.500 is 62.5 s. */
const TIMESTAMP = /^(?:(\d+):)?(\d{2}):(\d{2})\.(\d{3})$/;

function seconds(stamp: string): number | null {
    const m = TIMESTAMP.exec(stamp.trim());
    if (!m) return null;
    return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
}

export function parseVtt(text: string): Cue[] {
    // A byte-order mark (U+FEFF) may come first; line endings may be \n,
    // \r\n or \r.
    const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    const blocks = body.replace(/\r\n?/g, "\n").replace(/\n+$/, "").split(/\n{2,}/);
    if (!blocks[0].startsWith("WEBVTT")) throw new Error("webvtt: the file doesn't start with WEBVTT");
    const offset = timestampOffset(blocks[0]);

    const cues: Cue[] = [];
    for (const block of blocks.slice(1)) {
        const lines = block.split("\n");
        // NOTE, STYLE and REGION blocks carry no cue.
        if (/^(NOTE|STYLE|REGION)(\s|$)/.test(lines[0] ?? "")) continue;

        // The timing line comes first, or second after an identifier.
        const at = lines.findIndex((line) => line.includes("-->"));
        if (at < 0 || at > 1) continue;
        const [left, right] = lines[at].split("-->");
        const [endStamp, ...rest] = right.trim().split(/[ \t]+/);
        const start = seconds(left);
        const end = seconds(endStamp);
        if (start === null || end === null || end <= start) continue;

        const settings = new Map<string, string>();
        for (const setting of rest) {
            const colon = setting.indexOf(":");
            if (colon > 0) settings.set(setting.slice(0, colon), setting.slice(colon + 1));
        }
        cues.push({ start: start + offset, end: end + offset, text: lines.slice(at + 1).join("\n"), settings });
    }
    return cues;
}

/**
 * X-TIMESTAMP-MAP=MPEGTS:<ticks>,LOCAL:<time> says the cue time LOCAL is the
 * media time MPEGTS ÷ 90,000 (an MPEG-2 clock runs at 90 kHz). Without it,
 * cue time 0 is media time 0 (RFC 8216, section 3.5), which is what your
 * packager relies on: it writes no map, and your fMP4 media starts at 0.
 * A real player also handles the 33-bit MPEG-2 clock wrapping round, which
 * happens every 26.5 hours of live; this one doesn't.
 */
function timestampOffset(header: string): number {
    const line = header.split("\n").find((l) => l.startsWith("X-TIMESTAMP-MAP="));
    if (!line) return 0;
    const mpegts = /MPEGTS:(\d+)/.exec(line);
    const local = /LOCAL:([\d:.]+)/.exec(line);
    if (!mpegts || !local) return 0;
    return Number(mpegts[1]) / 90000 - (seconds(local[1]) ?? 0);
}