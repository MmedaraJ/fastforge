import type { MediaPlaylist } from "./hls/playlist";
import { readPresentation } from "./manifest";
import { takePreloaded, takePreparedKeys } from "./preload";
import { mimeFor, type AudioOption, type Rung, type SubtitleOption } from "./presentation";
import type { Engine, EngineOptions, LevelInfo } from "./types";
import { parseVtt, type Cue } from "./webvtt";
import { Eme } from "./eme";

/*
 * fastforge's own engine: HLS or DASH played straight through Media Source
 * Extensions, with no library in between.
 *
 * MSE splits the work. The browser still demuxes and decodes; your code
 * decides what to download, downloads it, and hands the bytes over. Every
 * engine you've used is this loop underneath:
 *
 *   pick the next segment (which track, which rendition) -> fetch it ->
 *   append it to that track's SourceBuffer -> repeat, while the buffer
 *   ahead of the playhead is below a target
 *
 * The rest of the file is the rules that loop needs: one operation per
 * SourceBuffer at a time, a limit on what's buffered behind the playhead,
 * an init segment before the first media segment of each rendition, starting
 * over after a seek, and telling the browser when the stream is complete.
 *
 * VOD with fMP4 (CMAF) segments and demuxed audio only: exactly what your
 * packager produces, and nothing it doesn't. The manifest format matters only
 * in load(): HLS and DASH both become one Presentation (presentation.ts), and
 * everything after that is the same code for both.
 */

/**
 * How far past the end of the buffered video audio may download: one segment
 * of your ladder. See audioMayLoad() for why audio needs a limit at all.
 */
const AUDIO_LEAD = 6;

/**
 * When the viewer changes audio language, the old language is cut this far
 * ahead of the playhead, once the new one has arrived. hls.js uses the same
 * 0.25 s (its nextAudioTrackBufferFlushForwardOffset). See switchAudio().
 */
const AUDIO_SWITCH_OFFSET = 0.25;

/** Seconds of media to keep downloaded ahead of the playhead. */
const BUFFER_AHEAD = 30;

/**
 * Seconds of already-played media to keep. Browsers cap each SourceBuffer
 * (Chrome allows roughly 150 MB of video), and a long VOD would hit that cap
 * if nothing were ever removed.
 */
const BUFFER_BEHIND = 30;

/** How often the scheduler checks whether a track needs its next segment. */
const TICK_MS = 250;

/** Tries per file before a network failure counts as fatal. */
const MAX_ATTEMPTS = 3;

/**
 * A video segment that arrives in less time than this came from the
 * browser's HTTP cache, not the network. See fetchBytes() for why that
 * matters. dash.js makes the same call with its cacheLoadThresholds setting
 * (10 ms for video in v5). In Chromium, cache hits of your 480p segments took
 * 3 to 31 ms from fetch() to the last byte (Step 0's runs), so 10 would have
 * let most of them through. Over the network, a segment takes at least one
 * round trip: 100 ms on your throttle, about 195 ms to your CDN in your HAR.
 * The cost: on a link with a round trip under 50 ms, real downloads of small
 * segments get skipped too. Resource Timing's transferSize (0 for a cache
 * hit) is exact, but cross-origin it reads 0 for everything unless the
 * server sends Timing-Allow-Origin.
 */
const FROM_CACHE_MS = 50;

interface Track {
    kind: "video" | "audio";
    buffer: SourceBuffer;
    /** The MIME type the SourceBuffer currently expects. */
    mime: string;
    /** Index of the next segment to download. */
    next: number;
    /** Rendition whose init segment was appended last; -1 before the first. */
    initLevel: number;
    /** A download or append is in flight: one at a time per SourceBuffer. */
    busy: boolean;
    /** The last segment has been appended. */
    done: boolean;
    /** Audio only: a new language was chosen and the loop hasn't acted on it yet. */
    switching: boolean;
}

/** What was appended where, so switches can be reported when they're seen. */
interface AppendedRange {
    start: number;
    end: number;
    level: number;
}

type MediaSourceCtor = typeof MediaSource;

export class MseEngine implements Engine {
    private readonly video: HTMLVideoElement;
    private readonly opts: EngineOptions;

    /** The video rungs, lowest bandwidth first, each with its segments. */
    private rungs: Rung[] = [];
        /** Every audio language, and the one the audio track downloads. */
    private audioOptions: AudioOption[] = [];
    private audioIndex = 0;
    /** The language of the audio last appended: what the viewer hears. */
    private audioHeard = -1;

    private subtitleOptions: SubtitleOption[] = [];
    /** The subtitles showing; -1 = off. */
    private textIndex = -1;

    /** The <video>'s TextTrack for each subtitle language, made when first chosen. */
    private readonly textTracks = new Map<number, TextTrack>();
    /** Per subtitle language: which of its files are already cues on the track. */
    private readonly textLoaded = new Map<number, Set<number>>();
    /** Per subtitle language: start|end|text of every cue added, to skip repeats. */
    private readonly cueKeys = new Map<number, Set<string>>();
    private textBusy = false;

    private mediaSource: MediaSource | null = null;
    /** Set for an encrypted asset. */
    private eme: Eme | null = null;
    private objectUrl = "";
    private tracks: Track[] = [];
    private timer = 0;

    /** Your ABR's latest choice. Used from the next video segment on. */
    private desired = 0;
    /** The viewer's pick from the level dropdown; overrides `desired`. */
    private pinned: number | null = null;

    private readonly appended: AppendedRange[] = [];
    private shownLevel = -1;

    /**
     * ManagedMediaSource (Safari, including iPhone since iOS 17.1) tells you
     * when it wants data, to save power. Plain MSE always does.
     */
    private streamingAllowed = true;

    /** Aborts in-flight downloads on a seek or on destroy. */
    private controller = new AbortController();
    /** Bumped by each seek, so work started before it can tell it's stale. */
    private epoch = 0;
    private streamEnded = false;
    private destroyed = false;
    private failed = false;

    private readonly onSeeking = () => this.restartFrom(this.video.currentTime);
    private readonly onVideoError = () => {
        const code = this.video.error?.code ?? 0;
        this.fail(new Error(`video element error ${code}`));
    };

    constructor(video: HTMLVideoElement, opts: EngineOptions) {
        this.video = video;
        this.opts = opts;
    }

    async load(url: string): Promise<void> {
        // HLS or DASH, read the same way the preloader reads it (manifest.ts)
        const presentation = await readPresentation(url, (u) => this.fetchText(u));
        if (this.destroyed) return;
        if (presentation.rungs.length === 0) throw new Error("mse: the manifest lists no video renditions");

        // From here on, nothing knows which format the manifest was.
        this.rungs = presentation.rungs;
        this.audioOptions = presentation.audio;
        this.subtitleOptions = presentation.subtitles;
        // Start with the language the manifest marks as default: DEFAULT=YES
        // in HLS, Role "main" in DASH. The first one if none is marked.
        this.audioIndex = Math.max(0, this.audioOptions.findIndex((a) => a.isDefault));

        const levels: LevelInfo[] = this.rungs.map((rung, index) => ({
            index,
            height: rung.height,
            bitrateKbps: Math.round(rung.bandwidth / 1000),
        }));

        // The Engine contract: report the levels before any media is
        // requested. player.ts calls start() from inside this callback, which
        // sets the rendition the first segment will come from.
        this.opts.onManifest(levels, presentation.audio.length);

        if (this.opts.drm) {
            // Before attach(): the CDM has to be on the element before the
            // first encrypted init segment is appended.
            this.eme = new Eme(this.video, this.opts.drm, (detail) => this.fail(new Error(detail)));
            const videoTypes = [...new Set(this.rungs.map((rung) => mimeFor(rung, "video")))];
            // A licence the preloader already fetched, or is still fetching:
            // waiting for that beats starting a second one.
            const prepared = await (takePreparedKeys(url) ?? Promise.resolve(null)).catch(() => null);
            await this.eme.attach(videoTypes, this.audioOptions.length > 0 ? mimeFor(this.rungs[this.desired], "audio") : null, prepared);
            if (this.destroyed) return;
        }

        await this.attach();
        if (this.destroyed) return;
        this.reportTracks();

        this.video.addEventListener("seeking", this.onSeeking);
        this.video.addEventListener("error", this.onVideoError);
        this.timer = window.setInterval(() => this.tick(), TICK_MS);
        this.tick();
    }

    start(openingLevel: number): void {
        // This engine has no ABR of its own. Under engine-default nobody
        // chooses for it, so it holds the bottom rung: a no-adaptation
        // baseline to compare real algorithms against.
        this.desired = openingLevel >= 0 ? this.clamp(openingLevel) : 0;
    }

    requestLevel(index: number): void {
        this.desired = this.clamp(index);
    }

    setLevel(index: number): void {
        // Takes effect from the next segment. hls.js's currentLevel setter
        // also throws away what's buffered to switch immediately; that's a
        // remove() on the video buffer plus restartFrom(currentTime), left
        // out here to keep the loop readable.
        this.pinned = index < 0 ? null : this.clamp(index);
    }

    selectAudio(id: number): void {
        if (id === this.audioIndex || !this.audioOptions[id]) return;
        this.audioIndex = id;
        // The loop makes the change, because only it knows when the audio
        // SourceBuffer is free: see switchAudio().
        const audio = this.tracks.find((t) => t.kind === "audio");
        if (audio) audio.switching = true;
        this.tick();
    }
    
    selectText(id: number): void {
        const option = id >= 0 ? this.subtitleOptions[id] : undefined;
        if (id >= 0 && !option) return;
        // The language showing is hidden, not emptied: its cues stay on its
        // track, so choosing it again shows them at once.
        const showing = this.textTracks.get(this.textIndex);
        if (showing) showing.mode = "disabled";
        this.textIndex = option ? id : -1;
        if (option) {
            let track = this.textTracks.get(id);
            if (!track) {
                track = textTrackFor(this.video, option);
                this.textTracks.set(id, track);
            }
            track.mode = "showing";
        }
        this.reportTracks();
        this.tick();
    }

    get autoEnabled(): boolean {
        return this.pinned === null;
    }

    async destroy(): Promise<void> {
        this.destroyed = true;
        window.clearInterval(this.timer);
        this.controller.abort();
        this.video.removeEventListener("seeking", this.onSeeking);
        this.video.removeEventListener("error", this.onVideoError);
        // A TextTrack can't be taken off its <video>, so leave each one
        // empty and switched off for the next engine, which may reuse it.
        for (const track of this.textTracks.values()) emptyTrack(track);
        if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
        // Let go of the element the way hls.js does: no src, then load().
        this.video.removeAttribute("src");
        this.video.load();
        this.mediaSource = null;
        this.tracks = [];
        // After the MediaSource is gone: keys come off an element that has
        // nothing left to decrypt.
        await this.eme?.destroy();
        this.eme = null;
    }

    // ---------------------------------------------------------------------
    // Setup
    // ---------------------------------------------------------------------

    /** Create the MediaSource, attach it to the <video>, add a SourceBuffer per track. */
    private attach(): Promise<void> {
        const scope = globalThis as { ManagedMediaSource?: MediaSourceCtor; MediaSource?: MediaSourceCtor };
        const Ctor = scope.ManagedMediaSource ?? scope.MediaSource;
        if (!Ctor) throw new Error("mse: this browser has no Media Source Extensions");

        const mediaSource = new Ctor();
        this.mediaSource = mediaSource;

        if (Ctor === scope.ManagedMediaSource) {
            // Safari opens a ManagedMediaSource only if AirPlay is off for the
            // element (or an AirPlay alternative is offered). hls.js does the
            // same thing; it's why AirPlay disappears with MSE on iPhone.
            this.video.disableRemotePlayback = true;
            this.streamingAllowed = false;
            mediaSource.addEventListener("startstreaming", () => {
                this.streamingAllowed = true;
                this.tick();
            });
            mediaSource.addEventListener("endstreaming", () => {
                this.streamingAllowed = false;
            });
        }

        return new Promise((resolveAttach, rejectAttach) => {
            mediaSource.addEventListener("sourceopen", () => {
                URL.revokeObjectURL(this.objectUrl);
                this.objectUrl = "";
                try {
                    this.createTracks(mediaSource);
                    resolveAttach();
                } catch (error) {
                    rejectAttach(error);
                }
            }, { once: true });

            // A blob: URL that stands for the MediaSource. Setting it as src is
            // what attaches the two; sourceopen fires once they're connected.
            this.objectUrl = URL.createObjectURL(mediaSource);
            this.video.src = this.objectUrl;
        });
    }

    private createTracks(mediaSource: MediaSource): void {
        const videoMime = mimeFor(this.rungs[this.desired], "video");
        if (!MediaSource.isTypeSupported(videoMime)) throw new Error(`mse: this browser can't play ${videoMime}`);
        const tracks: Track[] = [this.newTrack("video", mediaSource.addSourceBuffer(videoMime), videoMime)];

        if (this.audioOptions.length > 0) {
            const audioMime = mimeFor(this.rungs[this.desired], "audio");
            if (!MediaSource.isTypeSupported(audioMime)) throw new Error(`mse: this browser can't play ${audioMime}`);
            tracks.push(this.newTrack("audio", mediaSource.addSourceBuffer(audioMime), audioMime));
        }
        this.tracks = tracks;

        // Must be set before the first append. The longest track wins: your
        // video lasts 30.042 s and your audio 30.038 s.
        mediaSource.duration = Math.max(
            this.rungs[0].playlist.duration,
            this.audioOptions[this.audioIndex]?.playlist.duration ?? 0,
        );
    }

    private newTrack(kind: Track["kind"], buffer: SourceBuffer, mime: string): Track {
        return { kind, buffer, mime, next: 0, initLevel: -1, busy: false, done: false, switching: false };
    }

    // ---------------------------------------------------------------------
    // The loop
    // ---------------------------------------------------------------------

    private tick(): void {
        const ms = this.mediaSource;
        if (this.destroyed || this.failed || !ms || ms.readyState === "closed") return;

        if (this.streamingAllowed) {
            const now = this.video.currentTime;
            for (const track of this.tracks) {
                if (track.busy) continue;
                if (track.switching) {
                    void this.switchAudio(track);
                    continue;
                }
                if (track.done) continue;
                if (bufferedAhead(track.buffer, now) >= BUFFER_AHEAD) continue;
                if (track.kind === "audio" && !this.audioMayLoad(track, now)) continue;
                void this.loadNext(track);
            }
            if (this.textIndex >= 0 && !this.textBusy) void this.loadSubtitles(now);
        }

        this.reportShownLevel();
        this.endStreamIfComplete();
    }

    /**
     * Audio waits for video.
     *
     * Each track used to fill its own 30 s independently. Audio segments are
     * small (about 98 kB) and video segments big (1,061 kB for your first
     * 480p one), so at startup audio's loop fetched segments 1 to 5 while
     * video segment 1 was still downloading. The two shared the link, and
     * the first frame waited for both.
     *
     * Now audio may start a segment only if it begins less than AUDIO_LEAD
     * seconds after the end of the buffered video. At startup that allows
     * audio segment 1, which the first frame needs anyway. The same rule
     * holds after a seek and during a rebuffer, the other times video is the
     * track everyone is waiting for.
     */
    private audioMayLoad(audio: Track, now: number): boolean {
        const video = this.tracks.find((t) => t.kind === "video");
        if (!video || video.done) return true;
        const next = this.playlistFor(audio, 0).segments[audio.next];
        if (!next) return true;
        // Nothing buffered at the playhead yet (startup, or just after a
        // seek) counts as the video ending at the playhead.
        const videoEnd = bufferedEnd(video.buffer, now) ?? now;
        return next.start < videoEnd + AUDIO_LEAD;
    }

    /**
     * A new audio language, mid-play.
     *
     * Everything buffered ahead of the playhead is in the old language: up to
     * 36 s of it (BUFFER_AHEAD of video, plus AUDIO_LEAD). Letting it play
     * out would make the viewer wait that long, so it goes, but only once the
     * new language's first segment has arrived. Cut first and the sound stops
     * while the new segment downloads; that's a stall, and your session
     * counts it as a rebuffer.
     *
     * The cut is AUDIO_SWITCH_OFFSET ahead of where the playhead is when the
     * segment arrives, not where it was when the viewer chose. Old audio
     * between the playhead and the cut plays out; so does old audio the
     * browser has already read into its decoder. Appending over it isn't
     * enough: Chrome keeps playing frames it has read even when an append
     * replaces them in the buffer. remove() is what makes it drop them.
     */
    private async switchAudio(track: Track): Promise<void> {
        track.busy = true;
        const epoch = this.epoch;
        const language = this.audioIndex;
        try {
            const playlist = this.playlistFor(track, 0);
            const index = segmentAt(playlist, this.video.currentTime + AUDIO_SWITCH_OFFSET);
            const segment = playlist.segments[index];
            // Too close to the end for another segment: the old language finishes.
            if (!segment || !playlist.initUri) {
                track.switching = false;
                return;
            }

            // The new language's init segment and the segment that will
            // play next, together, as in loadNext().
            const [init, bytes] = await Promise.all([
                this.fetchBytes(playlist.initUri, false),
                this.fetchBytes(segment.uri, false),
            ]);
            // A seek, or another change of language, overtook this one.
            // `switching` is still set, so the next tick starts again from
            // wherever the playhead is now, in whichever language is chosen
            // now. A seek that aborted the downloads lands in the catch below
            // and comes back the same way.
            if (epoch !== this.epoch || language !== this.audioIndex) return;

            const ms = this.mediaSource;
            const ranges = track.buffer.buffered;
            const end = ranges.length > 0 ? ranges.end(ranges.length - 1) : 0;
            const cut = this.video.currentTime + AUDIO_SWITCH_OFFSET;
            if (ms && end > cut) await this.whenIdle(track, () => track.buffer.remove(cut, ms.duration));

            this.changeType(track, 0);
            await this.append(track, init);
            track.initLevel = 0;
            await this.append(track, bytes);
            track.next = index + 1;
            track.done = track.next >= playlist.segments.length;
            track.switching = false;
            // The stream may already have been declared complete. Appending
            // reopens it (the MSE spec moves an "ended" MediaSource back to
            // "open"), and it's declared complete again once done.
            this.streamEnded = false;

            this.audioHeard = language;
            this.reportTracks();
        } catch (error) {
            if (!isAbort(error)) this.fail(error);
        } finally {
            track.busy = false;
            this.tick();
        }
    }

    /**
     * Subtitle files near the playhead, turned into cues on the <video>'s
     * TextTrack. The browser draws them: nothing here runs per frame.
     * Like media, only what the next BUFFER_AHEAD seconds need is fetched;
     * unlike media, nothing is ever removed, because a 6 s subtitle file is
     * a few hundred bytes.
     */
    private async loadSubtitles(now: number): Promise<void> {
        const index = this.textIndex;
        const option = this.subtitleOptions[index];
        const track = this.textTracks.get(index);
        if (!option || !track) return;
        const loaded = this.textLoaded.get(index) ?? new Set<number>();
        this.textLoaded.set(index, loaded);
        const keys = this.cueKeys.get(index) ?? new Set<string>();
        this.cueKeys.set(index, keys);

        const n = option.playlist.segments.findIndex(
            (s, i) => !loaded.has(i) && s.start + s.duration > now && s.start < now + BUFFER_AHEAD,
        );
        if (n < 0) return;

        this.textBusy = true;
        try {
            const cues = parseVtt(await this.fetchText(option.playlist.segments[n].uri));
            loaded.add(n);
            for (const cue of cues) {
                // A cue that crosses a file boundary is written into both
                // files, so the second copy is skipped.
                const key = `${cue.start}|${cue.end}|${cue.text}`;
                if (keys.has(key)) continue;
                keys.add(key);
                track.addCue(toVttCue(cue));
            }
        } catch (error) {
            if (isAbort(error)) return;
            // Missing subtitles are worth a log line, not a dead player.
            loaded.add(n);
            const message = error instanceof Error ? error.message : String(error);
            this.opts.onError(`mse: subtitles: ${message}`, false);
        } finally {
            this.textBusy = false;
        }
    }

    private reportTracks(): void {
        this.opts.onTracks({
            audio: this.audioOptions.map((o, id) => ({ id, language: o.language, label: o.label })),
            text: this.subtitleOptions.map((o, id) => ({ id, language: o.language, label: o.label })),
            audioId: this.audioHeard,
            textId: this.textIndex,
        });
    }

    /** Download the track's next segment (and an init segment first, if the rendition changed) and append it. */
    private async loadNext(track: Track): Promise<void> {
        const epoch = this.epoch;
        track.busy = true;
        // Which language this download is in, for audio: a switch can be
        // asked for while it's on its way.
        const language = this.audioIndex;
        try {
            // Audio has one rendition per language. Video follows the dropdown, then your ABR.
            const level = track.kind === "video" ? (this.pinned ?? this.desired) : 0;
            const playlist = this.playlistFor(track, level);
            const segment = playlist.segments[track.next];
            if (!segment) {
                track.done = true;
                return;
            }

            // A new rendition starts with its init segment, which carries the
            // decoder setup. Because your ladder keeps keyframes and segment
            // boundaries aligned across rungs, segment N covers the same
            // seconds in every rung, so a switch is just this: one small file,
            // then segment N of the new rung.

            const newRendition = track.initLevel !== level;
            if (newRendition && !playlist.initUri) throw new Error("mse: media playlist has no EXT-X-MAP init segment");

            // Both URLs are known, so both requests go out together. Asking
            // for the segment only once the init segment had arrived cost one
            // round trip (100 ms on your throttle) at startup and at every
            // switch. The bytes still go into the buffer in order: init first.
            const [init, bytes] = await Promise.all([
                newRendition && playlist.initUri ? this.fetchBytes(playlist.initUri, false) : null,
                this.fetchBytes(segment.uri, track.kind === "video"),
            ]);
            if (epoch !== this.epoch) return;

            if (init) {
                this.changeType(track, level);
                await this.append(track, init);
                track.initLevel = level;
            }
            await this.removeBehind(track);
            await this.append(track, bytes);

            if (track.kind === "video") {
                this.appended.push({ start: segment.start, end: segment.start + segment.duration, level });
            } else if (language !== this.audioHeard) {
                // The first audio segment of the session is in.
                this.audioHeard = language;
                this.reportTracks();
            }
            // A seek that happened during the append moved `next` already.
            if (epoch === this.epoch) {
                track.next++;
                track.done = track.next >= playlist.segments.length;
            }
        } catch (error) {
            if (!isAbort(error)) this.fail(error);
        } finally {
            track.busy = false;
            // Straight on to the next segment if it's wanted, rather than
            // waiting up to TICK_MS for the timer. hls.js does the same: its
            // loop runs on a 100 ms timer and again whenever a fragment lands.
            this.tick();
        }
    }

    /**
     * After a seek: keep what's buffered at the new position, and continue
     * from its end; with nothing buffered there, start at the segment that
     * contains it. Downloads still in flight are for the old position, so
     * they're cancelled.
     */
    private restartFrom(time: number): void {
        if (this.destroyed || this.tracks.length === 0) return;

        // Every video rung shares the same segment times, so any rung's
        // playlist answers "which segment contains this time".
        const plan = this.tracks.map((track) => {
            const playlist = this.playlistFor(track, 0);
            const end = bufferedEnd(track.buffer, time);
            return end === null ? segmentAt(playlist, time) : segmentAfter(playlist, end);
        });

        // A seek inside what's already buffered changes nothing: let the
        // downloads in flight finish. So does a seek into the segment that's
        // already downloading.
        if (plan.every((next, i) => next === this.tracks[i].next)) return;

        this.epoch++;
        this.controller.abort();
        this.controller = new AbortController();
        this.streamEnded = false;
        this.tracks.forEach((track, i) => {
            track.next = plan[i];
            track.done = plan[i] >= this.playlistFor(track, 0).segments.length;
        });
        this.tick();
    }

    /**
     * When every track has appended its last segment, tell the browser no
     * more data is coming. Only then does the playhead run to the very end
     * and fire `ended` -- the event hls.js didn't reliably deliver for your
     * clip, which is why player.ts has reachedEnd(). Here you can call it
     * yourself.
     */
    private endStreamIfComplete(): void {
        const ms = this.mediaSource;
        if (this.streamEnded || !ms || ms.readyState !== "open") return;
        if (!this.tracks.every((t) => t.done && !t.busy && !t.buffer.updating)) return;
        this.streamEnded = true;
        ms.endOfStream();
    }

    /**
     * Three moments in every switch: your ABR decides, the segment downloads,
     * the viewer sees it. Shaka reports the first and hls.js the third. This
     * engine reports the third too, by finding which appended segment the
     * playhead is in, so time at each bitrate is charged from when it was
     * actually on screen.
     */
    private reportShownLevel(): void {
        const now = this.video.currentTime;
        // Newest first: a range appended later replaces older data there.
        for (let i = this.appended.length - 1; i >= 0; i--) {
            const range = this.appended[i];
            if (now < range.start || now >= range.end) continue;
            if (range.level !== this.shownLevel) {
                this.shownLevel = range.level;
                this.opts.onSwitch(range.level);
            }
            return;
        }
    }

    // ---------------------------------------------------------------------
    // SourceBuffer operations
    // ---------------------------------------------------------------------

    /**
     * Your rungs are all H.264 but at different levels (avc1.64001e for
     * 480p, avc1.640028 for 1080p). changeType() tells the SourceBuffer what
     * the next init segment will be; browsers that predate it accept a
     * profile or level change within the same codec anyway.
     */
    private changeType(track: Track, level: number): void {
        const mime = mimeFor(this.rungs[level], track.kind);
        if (mime === track.mime) return;
        if (typeof track.buffer.changeType === "function") track.buffer.changeType(mime);
        track.mime = mime;
    }

    private async append(track: Track, bytes: ArrayBuffer): Promise<void> {
        try {
            await this.whenIdle(track, () => track.buffer.appendBuffer(bytes));
        } catch (error) {
            if (!(error instanceof DOMException && error.name === "QuotaExceededError")) throw error;
            // The browser's per-buffer cap is reached. Drop everything already
            // played except the last second, then try once more.
            await this.removeBefore(track, this.video.currentTime - 1);
            await this.whenIdle(track, () => track.buffer.appendBuffer(bytes));
        }
    }

    private removeBehind(track: Track): Promise<void> {
        return this.removeBefore(track, this.video.currentTime - BUFFER_BEHIND);
    }

    private async removeBefore(track: Track, cutoff: number): Promise<void> {
        const ranges = track.buffer.buffered;
        if (cutoff <= 0 || ranges.length === 0 || ranges.start(0) >= cutoff) return;
        await this.whenIdle(track, () => track.buffer.remove(0, cutoff));
    }

    /**
     * appendBuffer() and remove() return immediately and finish later, with
     * an `updateend` event. A second call before then throws
     * InvalidStateError, so each operation waits for the one before it.
     */
    private whenIdle(track: Track, operation: () => void): Promise<void> {
        const buffer = track.buffer;
        return new Promise((resolveOp, rejectOp) => {
            const cleanup = () => {
                buffer.removeEventListener("updateend", onEnd);
                buffer.removeEventListener("error", onError);
            };
            const onEnd = () => {
                cleanup();
                resolveOp();
            };
            const onError = () => {
                cleanup();
                rejectOp(new Error(`mse: the ${track.kind} buffer rejected the data`));
            };
            buffer.addEventListener("updateend", onEnd);
            buffer.addEventListener("error", onError);
            try {
                operation();
            } catch (error) {
                cleanup();
                rejectOp(error);
            }
        });
    }

    // ---------------------------------------------------------------------
    // Network
    // ---------------------------------------------------------------------

    private async fetchText(url: string): Promise<string> {
        const preloaded = await this.fromPreload(url);
        if (preloaded) return new TextDecoder().decode(preloaded);

        const response = await fetch(url, { signal: this.controller.signal });
        if (!response.ok) throw new Error(`mse: ${response.status} for ${url}`);

        return response.text();
    }

    /**
     * Network errors and 5xx responses are retried with a growing pause;
     * a 4xx is not, because asking again won't change the answer. Only video
     * media segments are measured: audio and init segments are small enough
     * that their timing is mostly latency.
     */
    private async fetchBytes(url: string, measure: boolean): Promise<ArrayBuffer> {
        // Preloaded bytes are never measured. They crossed the network
        // earlier, while something else was playing. Timed now, your first
        // 480p segment (1,060,817 bytes) comes out of memory in under a
        // millisecond: over 8.5 million kbps. As the session's first sample
        // that is the whole estimate (the EWMA's zero-bias correction does
        // that with one sample), and your throughput rule asks for 720p on a
        // link that can't carry it.
        const preloaded = await this.fromPreload(url);
        if (preloaded) return preloaded;

        let lastError: unknown = null;
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            const started = performance.now();
            try {
                const response = await fetch(url, { signal: this.controller.signal });
                if (response.status >= 400 && response.status < 500) {
                    throw Object.assign(new Error(`mse: ${response.status} for ${url}`), { permanent: true });
                }
                if (!response.ok) throw new Error(`mse: ${response.status} for ${url}`);
                const bytes = await response.arrayBuffer();
                const seconds = (performance.now() - started) / 1000;
                // Cache hits are never measured, for the same reason as
                // preloaded bytes. Scroll back to a video you watched a
                // minute ago and its segments come out of the browser's
                // cache: timed like downloads, they pushed the estimate to
                // 456,265 kbps in Step 0's first try, which compared the time
                // to the first byte with 5 ms and let them through.
                if (measure && seconds * 1000 >= FROM_CACHE_MS) this.opts.onDownload(bytes.byteLength, seconds);
                return bytes;
            } catch (error) {
                if (isAbort(error) || (error as { permanent?: boolean }).permanent) throw error;
                lastError = error;
                if (attempt < MAX_ATTEMPTS) await sleep(500 * attempt, this.controller.signal);
            }
        }
        throw lastError;
    }

    /**
     * The preloaded download of `url`, if the feed fetched it ahead of time
     * (preload.ts). Null if it didn't, or if that download failed, and then
     * the caller fetches the file itself.
     */
    private async fromPreload(url: string): Promise<ArrayBuffer | null> {
        const entry = takePreloaded(url);
        if (!entry) return null;
        try {
            return await entry;
        } catch {
            return null;
        }
    }

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    private playlistFor(track: Track, level: number): MediaPlaylist {
        return track.kind === "video" ? this.rungs[level].playlist : this.audioOptions[this.audioIndex].playlist;
    }

    private clamp(index: number): number {
        return Math.max(0, Math.min(index, this.rungs.length - 1));
    }

    private fail(error: unknown): void {
        if (this.failed || this.destroyed) return;
        this.failed = true;
        window.clearInterval(this.timer);
        const message = error instanceof Error ? error.message : String(error);
        this.opts.onError(message.startsWith("mse:") ? message : `mse: ${message}`, true);
    }
}

/** Seconds buffered ahead of `time` in the range that contains it. */
function bufferedAhead(buffer: SourceBuffer, time: number): number {
    const end = bufferedEnd(buffer, time);
    return end === null ? 0 : end - time;
}

/** End of the buffered range containing `time`, or null if `time` isn't buffered. */
function bufferedEnd(buffer: SourceBuffer, time: number): number | null {
    const ranges = buffer.buffered;
    for (let i = 0; i < ranges.length; i++) {
        // A small tolerance: after a seek the playhead can sit a few ms
        // before the first sample of the range it lands in.
        if (time >= ranges.start(i) - 0.1 && time <= ranges.end(i)) return ranges.end(i);
    }
    return null;
}

/** Index of the segment containing `time`; segments.length past the end. */
function segmentAt(playlist: MediaPlaylist, time: number): number {
    const index = playlist.segments.findIndex((s) => time < s.start + s.duration);
    return index === -1 ? playlist.segments.length : index;
}

/**
 * Index of the first segment not yet buffered, given where the buffered range
 * ends; segments.length if they all are.
 *
 * The range ends on a segment boundary, but only roughly: EXTINF is rounded
 * to the millisecond, while real boundaries fall on frame times (1/24 s for
 * your video, 1024/48000 s for AAC audio). So "already buffered" means "more
 * than half of it lies before the end". A fixed allowance can't work: your
 * clip's last segments are 0.042 s (video) and 0.021 s (audio), shorter than
 * any allowance big enough to absorb the rounding over a long stream.
 */
function segmentAfter(playlist: MediaPlaylist, bufferedEnd: number): number {
    const index = playlist.segments.findIndex((s) => s.start + s.duration / 2 > bufferedEnd);
    return index === -1 ? playlist.segments.length : index;
}

function isAbort(error: unknown): boolean {
    return error instanceof DOMException && error.name === "AbortError";
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolveSleep, rejectSleep) => {
        const timer = window.setTimeout(resolveSleep, ms);
        signal.addEventListener("abort", () => {
            window.clearTimeout(timer);
            rejectSleep(new DOMException("aborted", "AbortError"));
        }, { once: true });
    });
}

/**
 * The TextTracks this file made. A TextTrack can never be taken off its
 * <video> (there's addTextTrack() but no remove), and your page plays every
 * session on the same element, so each engine reuses the track an earlier
 * one made for the same language rather than piling up new ones.
 */
const madeHere = new WeakSet<TextTrack>();

function textTrackFor(video: HTMLVideoElement, option: SubtitleOption): TextTrack {
    const existing = Array.from(video.textTracks).find(
        (t) => madeHere.has(t) && t.label === option.label && t.language === option.language,
    );
    const track = existing ?? video.addTextTrack("subtitles", option.label, option.language);
    madeHere.add(track);
    emptyTrack(track);
    return track;
}

/** Remove every cue and switch the track off. Its cue list only exists while it isn't "disabled". */
function emptyTrack(track: TextTrack): void {
    track.mode = "hidden";
    while (track.cues && track.cues.length > 0) track.removeCue(track.cues[0]);
    track.mode = "disabled";
}

/** A parsed cue as the browser's VTTCue, with the settings it understands. */
function toVttCue(cue: Cue): VTTCue {
    const out = new VTTCue(cue.start, cue.end, cue.text);
    for (const [key, value] of cue.settings) {
        // VTTCue throws on a value it doesn't accept; the browser's own
        // parser skips those, and so does this.
        try {
            if (key === "align") out.align = value as AlignSetting;
            else if (key === "vertical") out.vertical = value as DirectionSetting;
            else if (key === "size") out.size = parseFloat(value);
            else if (key === "position") out.position = parseFloat(value);
            else if (key === "line") {
                // "85%" is a percentage of the picture's height; "-1" counts
                // lines from the bottom.
                out.snapToLines = !value.includes("%");
                out.line = parseFloat(value);
            }
        } catch {
            // skipped
        }
    }
    return out;
}