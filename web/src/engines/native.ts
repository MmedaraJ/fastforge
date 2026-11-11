import type { Engine, EngineOptions, LevelInfo, TrackInfo } from "./types";
import { parseMaster } from "./hls/playlist";

/**
 * The browser's own audio-track list. Safari has it; Chrome only behind a
 * flag, and TypeScript's DOM types don't declare it, so it's described here.
 */
interface AudioTrackLike {
    enabled: boolean;
    language: string;
    label: string;
}
interface AudioTrackListLike extends EventTarget {
    readonly length: number;
    [index: number]: AudioTrackLike;
}

/**
 * The browser's own HLS player: put the playlist URL in video.src and let the
 * browser do everything else.
 *
 * Only needed where Media Source Extensions (MSE) don't exist. hls.js and
 * Shaka both work by downloading segments themselves and feeding them into
 * MSE, so without it they can't run at all. Today that means iPhones that
 * can't update to iOS 17.1, the release that brought Safari's version of MSE
 * (ManagedMediaSource) to iPhone.
 *
 * In this mode the browser reads the playlist, picks the renditions and
 * downloads the segments. The page only sees the <video> element's events.
 * That's why this engine can't take ABR orders, never calls onDownload, and
 * has to work out which rendition is playing from the size of the picture.
 */
export class NativeEngine implements Engine {
    private readonly video: HTMLVideoElement;
    private readonly opts: EngineOptions;
    private url = "";
    private levels: LevelInfo[] = [];
    private lastReported = -1;

    // An arrow function stored in a field, so the exact same function object
    // can be passed to both addEventListener and removeEventListener.
    private readonly onPictureSize = () => this.reportRendition();
    private readonly onTrackChange = () => this.reportTracks();

    /**
     * Text tracks already on the <video> before this engine handed it a
     * playlist. A TextTrack can never be taken off its element, so tracks
     * from earlier sessions (hls.js and your MSE engine both make them) are
     * still listed in video.textTracks; these aren't this playlist's.
     */
    private readonly earlier: Set<TextTrack>;

    constructor(video: HTMLVideoElement, opts: EngineOptions) {
        this.video = video;
        this.opts = opts;
        this.earlier = new Set(Array.from(video.textTracks));
    }

    async load(url: string): Promise<void> {
        // The browser will read this playlist too, but it never tells the page
        // what's in it. Fetching our own copy is the only way to list the
        // renditions. Two costs:
        //  - Up to one extra round trip before playback starts (none if the
        //    browser's second read comes from its HTTP cache), so startup
        //    here is slightly slower than a real native player.
        //  - fetch() needs CORS, while the <video> element's own requests
        //    don't. Your R2 bucket's CORS rule already allows this page's
        //    origins, so this works.
        const response = await fetch(url);
        if (!response.ok) throw new Error(`native: master playlist returned ${response.status}`);
        const playlist = parseMaster(await response.text(), url);

        this.url = url;
        this.levels = playlist.variants.map((variant, index) => ({
            index,
            height: variant.height,
            bitrateKbps: Math.round(variant.bandwidth / 1000),
        }));

        // player.ts calls start() from inside this callback, as the Engine
        // contract requires.
        this.opts.onManifest(this.levels, playlist.audio.length);
    }

    // No openingLevel parameter. TypeScript lets a method take fewer
    // parameters than the interface lists, and this one has no use for it:
    // the browser picks the opening rendition itself.
    start(): void {
        // 'resize' fires when videoWidth or videoHeight changes. In native
        // playback that's the only sign the browser has switched rendition.
        // 'loadedmetadata' catches the first rendition, in case a browser
        // doesn't fire 'resize' for it.
        this.video.addEventListener("loadedmetadata", this.onPictureSize);
        this.video.addEventListener("resize", this.onPictureSize);

        // In native playback the browser lists the playlist's languages
        // itself: audio in video.audioTracks, subtitles in video.textTracks.
        // Both fill in after the playlist is read, and announce it.
        this.audioTracks()?.addEventListener("addtrack", this.onTrackChange);
        this.audioTracks()?.addEventListener("change", this.onTrackChange);
        this.video.textTracks.addEventListener("addtrack", this.onTrackChange);
        this.video.textTracks.addEventListener("change", this.onTrackChange);

        // This line is the whole engine: hand the playlist to the browser.
        this.video.src = this.url;
    }

    // The browser chooses every rendition, and has no API for being told
    // otherwise. player.ts knows this from CAN_SELECT_LEVEL and doesn't send
    // requests; these exist because the interface requires them.
    requestLevel(): void {}
    setLevel(): void {}

    get autoEnabled(): boolean {
        return true;
    }

    selectAudio(id: number): void {
        const list = this.audioTracks();
        if (!list) return;
        for (let i = 0; i < list.length; i++) list[i].enabled = i === id;
    }

    selectText(id: number): void {
        this.subtitleTracks().forEach((track, i) => {
            track.mode = i === id ? "showing" : "disabled";
        });
    }

    async destroy(): Promise<void> {
        this.audioTracks()?.removeEventListener("addtrack", this.onTrackChange);
        this.audioTracks()?.removeEventListener("change", this.onTrackChange);
        this.video.textTracks.removeEventListener("addtrack", this.onTrackChange);
        this.video.textTracks.removeEventListener("change", this.onTrackChange);
        this.video.removeEventListener("loadedmetadata", this.onPictureSize);
        this.video.removeEventListener("resize", this.onPictureSize);
        // Removing src alone doesn't make the element let go of the stream;
        // calling load() with no source does. hls.js does exactly this when
        // it detaches.
        this.video.removeAttribute("src");
        this.video.load();
    }

    private audioTracks(): AudioTrackListLike | undefined {
        return (this.video as unknown as { audioTracks?: AudioTrackListLike }).audioTracks;
    }

    /** The playlist's subtitles, as the browser lists them. */
    private subtitleTracks(): TextTrack[] {
        return Array.from(this.video.textTracks).filter(
            (t) => !this.earlier.has(t) && (t.kind === "subtitles" || t.kind === "captions"),
        );
    }

    private reportTracks(): void {
        const list = this.audioTracks();
        const audio: TrackInfo[] = [];
        let audioId = -1;
        for (let i = 0; i < (list?.length ?? 0); i++) {
            const t = (list as AudioTrackListLike)[i];
            audio.push({ id: i, language: t.language, label: t.label || t.language });
            if (t.enabled) audioId = i;
        }
        const subtitles = this.subtitleTracks();
        this.opts.onTracks({
            audio,
            text: subtitles.map((t, id) => ({ id, language: t.language, label: t.label || t.language })),
            audioId,
            textId: subtitles.findIndex((t) => t.mode === "showing"),
        });
    }

    private reportRendition(): void {
        // The other engines are TOLD which rendition is playing. This one
        // infers it from the picture's height, which only works while every
        // rendition has a different height. Two 720p rungs at different
        // bitrates would look identical here, and a switch between them would
        // go unseen.
        const index = this.levels.findIndex((level) => level.height === this.video.videoHeight);
        if (index < 0 || index === this.lastReported) return;
        this.lastReported = index;
        this.opts.onSwitch(index);
    }
}
