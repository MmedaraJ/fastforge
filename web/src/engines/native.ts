import type { Engine, EngineOptions, LevelInfo } from "./types";
import { parseMaster } from "./hls/playlist";

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

    constructor(video: HTMLVideoElement, opts: EngineOptions) {
        this.video = video;
        this.opts = opts;
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

    async destroy(): Promise<void> {
        this.video.removeEventListener("loadedmetadata", this.onPictureSize);
        this.video.removeEventListener("resize", this.onPictureSize);
        // Removing src alone doesn't make the element let go of the stream;
        // calling load() with no source does. hls.js does exactly this when
        // it detaches.
        this.video.removeAttribute("src");
        this.video.load();
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
