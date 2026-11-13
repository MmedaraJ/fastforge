import shaka from "shaka-player";
import type { Engine, EngineOptions, LevelInfo, TrackInfo } from "./types";

// Fills in browser APIs Shaka expects but some browsers lack. Must run before
// any Player is created.
shaka.polyfill.installAll();

/*
 * The parts of Shaka's API this file uses, written out here.
 *
 * Shaka's TypeScript definitions are generated from its own annotations and
 * change shape between releases. By describing only the members we actually
 * call, and converting Shaka's objects to these types in one place, a Shaka
 * upgrade can only break this file, and the compiler points at exactly where.
 * This pattern is sometimes called an anti-corruption layer: an outside
 * system's model stops at the boundary instead of spreading through your code.
 */
interface ShakaTrack {
    id: number;
    bandwidth: number;
    height: number | null;
    audioId: number | null;
    active: boolean;
}

interface ShakaVariant {
    id: number;
    bandwidth: number;
    video: { height?: number } | null;
    audio: { id: number } | null;
}

/** One audio language, as getAudioTracks() lists it. */
interface ShakaAudioTrack {
    language: string;
    label: string | null;
    active: boolean;
}

/** One subtitle language, as getTextTracks() lists it. */
interface ShakaTextTrack {
    id: number;
    language: string;
    label: string | null;
    active: boolean;
}

interface ShakaResponse {
    uri: string;
    data: ArrayBuffer | ArrayBufferView;
    timeMs?: number;
}

interface ShakaPlayer {
    attach(video: HTMLMediaElement): Promise<void>;
    load(url: string): Promise<void>;
    destroy(): Promise<void>;
    configure(config: object): boolean;
    getConfiguration(): { abr: { enabled: boolean } };
    getVariantTracks(): ShakaTrack[];
    selectVariantTrack(track: ShakaTrack, clearBuffer?: boolean): void;
    getManifest(): { variants: ShakaVariant[] } | null;
    getAudioTracks(): ShakaAudioTrack[];
    selectAudioTrack(track: ShakaAudioTrack, safeMargin?: number): void;
    getTextTracks(): ShakaTextTrack[];
    selectTextTrack(track: ShakaTextTrack | null): void;
    getNetworkingEngine(): {
        registerRequestFilter(filter: (type: number, request: { uris: string[]; headers: Record<string, string> }) => void): void;
        registerResponseFilter(filter: (type: number, response: ShakaResponse) => void): void;
    } | null;
    addEventListener(type: string, listener: (event: Event) => void): void;
}

const SEGMENT_REQUEST: number = shaka.net.NetworkingEngine.RequestType.SEGMENT;
const LICENSE_REQUEST: number = shaka.net.NetworkingEngine.RequestType.LICENSE;
const CRITICAL: number = shaka.util.Error.Severity.CRITICAL;

/**
 * Is this URL a video media segment?
 *
 * Unlike hls.js, Shaka doesn't give network filters a reliable, version-stable
 * way to tell audio from video. So this relies on how YOUR packager lays out
 * files: video under "<height>p/", audio under "audio/", init segments named
 * init.mp4.
 *
 * That's a real weakness and worth knowing about: the two engines decide "is
 * this a video segment" differently. If your packager's layout ever changes,
 * this quietly starts counting the wrong files. If the two engines' measured
 * throughput disagrees, check here first.
 * 
 * files: video under "<height>p/", audio under "audio/<language>/", subtitles
 * under "text/<language>/" as .vtt files, init segments named init.mp4.
 * Subtitle segments are about 150 bytes each: timed as video, each would be
 * a sample of about 10 kbps (150 bytes in a 100 ms round trip), dragging the
 * estimate down.
 */
function isVideoMedia(uri: string): boolean {
    return !uri.includes("/audio/") && !uri.includes("/text/") && !uri.endsWith("init.mp4") && !uri.endsWith(".vtt");
}

/**
 * A Shaka AbrManager that makes no decisions of its own.
 *
 * Shaka asks its AbrManager which variant to play. This one answers with
 * whatever player.ts last requested. Your ABR algorithm still makes every
 * decision; this class just delivers those decisions in the form Shaka
 * expects. It's the adapter between "you set values on it" and "it calls
 * your code".
 *
 * Shaka's AbrManager interface gains methods between versions. The no-op
 * methods at the bottom are the ones this class doesn't need. If the console
 * shows "<something> is not a function" coming from Shaka, your version wants
 * another one: add it as a no-op.
 */
class ObeyingAbrManager {
    private variants: ShakaVariant[] = [];
    private current: ShakaVariant | null = null;
    private switchTo: ((variant: ShakaVariant, clearBuffer?: boolean) => void) | null = null;
    private readonly onVariants: (sorted: ShakaVariant[]) => void;

    /** Set by start() for the opening choice. */
    desired = 0;
    /** Set when the viewer pins a level. While set, it overrides every request. */
    pinned: number | null = null;
    /** Your ABR's latest choice, waiting for the next segment boundary. */
    private pending: number | null = null;

    constructor(onVariants: (sorted: ShakaVariant[]) => void) {
        this.onVariants = onVariants;
    }

    /** Shaka hands over the function to call when we want to switch. */
    init(switchCallback: (variant: ShakaVariant, clearBuffer?: boolean) => void): void {
        this.switchTo = switchCallback;
    }

    setVariants(variants: ShakaVariant[]): boolean {
        this.variants = [...variants].sort((a, b) => a.bandwidth - b.bandwidth);
        // This is where the engine reports the manifest to player.ts, which
        // calls start() before this returns, so that chooseVariant(), which
        // Shaka calls next, already knows the opening level.
        this.onVariants(this.variants);
        return true;
    }

    /** Shaka asks: which variant? Called for the opening choice, and sometimes later. */
    chooseVariant(): ShakaVariant | undefined {
        const index = Math.min(this.pinned ?? this.desired, this.variants.length - 1);
        this.current = this.variants[index] ?? this.variants[0] ?? null;
        return this.current ?? undefined;
    }

    /**
     * player.ts's choice for upcoming segments. Remembered here; ShakaEngine
     * applies it with applyPending() when no video segment is on its way.
     *
     * Switching on the spot is what made BOLA chaotic. Your ABR re-asks every
     * 500 ms, and a switch while a video segment is downloading makes Shaka
     * throw that segment away and fetch it again from the new rung. Shaka
     * cancels it outright when the bytes still to come exceed the new rung's
     * whole segment (StreamingEngine's shouldAbortCurrentRequest_), and even a
     * finished download is fetched again if the switch lands before it's
     * appended. So every time BOLA changed its mind mid-download, the 720p
     * segment on its way was thrown away and refetched at 480p.
     */
    request(index: number): void {
        this.pending = index;
    }

    /**
     * Apply the latest choice. ShakaEngine calls this only when no video
     * segment is on its way, so nothing can be thrown away, and Shaka fetches
     * the next segment from whichever rung is chosen now. That's the contract
     * of hls.js's nextAutoLevel: a choice applies to the next segment fetched,
     * never to one already on its way.
     */
    applyPending(): void {
        if (this.pending === null) return;
        const index = this.pinned ?? this.pending;
        this.pending = null;
        this.switchToIndex(index);
    }

    /** The viewer's pick from the level dropdown, applied straight away. null = automatic again. */
    pin(index: number | null): void {
        this.pinned = index;
        if (index !== null) this.switchToIndex(index);
    }

    private switchToIndex(index: number): void {
        const target = this.variants[index];
        if (!target || target === this.current || !this.switchTo) return;
        this.current = target;
        // false = keep what's already buffered and switch from the next segment.
        // Remembered for chooseVariant(). Shaka asks again whenever the
        // audio language changes, with that language's variants, and the
        // answer must be the rung playing now, not the opening one.
        this.desired = index;
        this.switchTo(target, false);
    }

    // Required by Shaka's interface, not needed here.
    stop(): void {}
    release(): void {}
    enable(): void {}
    disable(): void {}
    segmentDownloaded(): void {}
    trySuggestStreams(): void {}
    getBandwidthEstimate(): number {
        return 0;
    }
    playbackRateChanged(): void {}
    setMediaElement(): void {}
    setCmsdManager(): void {}
    configure(): void {}
    // Not in your 5.3.3. Shaka's main branch added it on 24 October 2026 and
    // calls it without checking it exists, so the next minor release would
    // throw "setPlayerInterface is not a function" without this line.
    setPlayerInterface(): void {}
}

interface Entry {
    id: number;
    height: number;
    bandwidth: number;
    audioId: number | null;
}

export class ShakaEngine implements Engine {
    private readonly player: ShakaPlayer;
    private readonly manager: ObeyingAbrManager | null;

    /** The Shaka variant id at each of our level indices. */
    private ids: number[] = [];
    /** The picture height at each of our level indices. */
    private heights: number[] = [];
    private announced = false;
    private lastReported = -1;
    private readonly video: HTMLVideoElement;
    private readonly opts: EngineOptions;
    private readonly onResize = () => this.reportShown();
    /**
     * A video segment has been requested and isn't in the buffer yet. While
     * true, your ABR's choices wait. Cleared by Shaka's 'segmentappended'. A
     * download cancelled by a seek never gets there; then choices wait until
     * the next segment is appended, which is late but never wrong.
     */
    private videoInFlight = false;

    constructor(video: HTMLVideoElement, opts: EngineOptions) {
        this.video = video;
        this.opts = opts;
        this.player = new shaka.Player() as unknown as ShakaPlayer;

        // Keep up to 30 s buffered ahead, like hls.js (maxBufferLength) and your
        // MSE engine. Shaka's default is 10 s (streaming.bufferingGoal), which
        // holds the buffer right on BOLA's 480p-to-720p switch point (9.65 s for
        // your ladder): BOLA then flips between the two however good the
        // network is. It also means the engines differed in buffer policy, not
        // just in code, so any comparison between them mixed the two.
        this.player.configure({ streaming: { bufferingGoal: 30 } });

        // DRM. Shaka reads the key systems the manifest offers and uses the
        // first one it has a licence server for. It plays Clear Key from
        // DASH only: in HLS it accepts no Clear Key KEYFORMAT (error 4026).
        if (opts.drm) this.player.configure({ drm: { servers: { [opts.drm.keySystem]: opts.drm.licenseUrl } } });

        // Only install the custom manager when your algorithm is in charge.
        // Otherwise Shaka keeps its built-in ABR, which is the control arm.
        this.manager = opts.ownAbr
            ? new ObeyingAbrManager((variants) =>
                  this.announce(
                      variants.map((v) => ({
                          id: v.id,
                          height: v.video?.height ?? 0,
                          bandwidth: v.bandwidth,
                          audioId: v.audio?.id ?? null,
                      })),
                  ),
              )
            : null;

        if (this.manager) {
            const manager = this.manager;
            this.player.configure({ abrFactory: () => manager });
        }

        const net = this.player.getNetworkingEngine();

        // A request filter runs just before a request goes out.
        net?.registerRequestFilter((type, request) => {
            // The viewer's token, on licence requests only.
            if (type === LICENSE_REQUEST && opts.drm) request.headers["Authorization"] = `Bearer ${opts.drm.token}`;
            if (type === SEGMENT_REQUEST && isVideoMedia(request.uris[0] ?? "")) this.videoInFlight = true;
        });

        net?.registerResponseFilter((type, response) => {
            if (type !== SEGMENT_REQUEST || !isVideoMedia(response.uri) || !response.timeMs) return;
            this.opts.onDownload(response.data.byteLength, response.timeMs / 1000);
        });

        // The segment boundary. Shaka fires 'segmentappended' once a segment is
        // in the buffer, and schedules the next fetch only after its listeners
        // have run (StreamingEngine: onSegmentAppended, then scheduleUpdate_).
        // So a choice applied here is the one that fetch uses. The download
        // that just finished has already reached your ABR through onDownload,
        // so the choice includes the freshest measurement there is.
        this.player.addEventListener("segmentappended", (event) => {
            if ((event as unknown as { contentType?: string }).contentType !== "video") return;
            this.videoInFlight = false;
            this.manager?.applyPending();
        });

        // Switches are reported when the new rung reaches the screen, the way
        // hls.js reports LEVEL_SWITCHED. Shaka's own events can't do that:
        // 'adaptation' fires when a switch is decided, so it counted every
        // change of mind as a switch, and charged playing time to rungs the
        // viewer never saw. The video element fires 'resize' when the picture
        // on screen changes size, and each rung of your ladder has its own
        // height, so the height says which rung is showing. (A ladder with two
        // rungs of the same height, say two 1080p bitrates, would need
        // something else.)
        this.video.addEventListener("resize", this.onResize);

        // The menus: an audio language chosen ('variantchanged', fired when
        // Shaka switches, before the new language is heard), subtitles
        // chosen ('textchanged'), and the lists themselves ('trackschanged').
        for (const type of ["variantchanged", "textchanged", "trackschanged"]) {
            this.player.addEventListener(type, () => this.reportTracks());
        }

        this.player.addEventListener("error", (event) => {
            const detail = (event as unknown as { detail: { code: number; severity: number } }).detail;
            this.opts.onError(`shaka/${detail.code}`, detail.severity === CRITICAL);
        });
    }

    async load(url: string): Promise<void> {
        if (!shaka.Player.isBrowserSupported()) {
            throw new Error("Shaka Player is not supported in this browser");
        }
        await this.player.attach(this.video);
        await this.player.load(url);

        // With Shaka's built-in ABR, nothing reported the variants during
        // load, so read them now. The opening choice was Shaka's own, which is
        // correct for the control arm.
        if (!this.manager) {
            const tracks = [...this.player.getVariantTracks()].sort((a, b) => a.bandwidth - b.bandwidth);
            this.announce(
                tracks.map((t) => ({
                    id: t.id,
                    height: t.height ?? 0,
                    bandwidth: t.bandwidth,
                    audioId: t.audioId,
                })),
            );
        }

        // hls.js reports the starting level as a switch; this matches that.
        // If the first frame isn't decoded yet, the 'resize' that comes with it
        // reports it instead.
        this.reportShown();
        this.reportTracks();
    }

    start(openingLevel: number): void {
        // With the custom manager, this runs inside setVariants, just before
        // Shaka calls chooseVariant(). With built-in ABR, Shaka has already
        // started by the time this runs, so there's nothing to do.
        if (this.manager && openingLevel >= 0) this.manager.desired = openingLevel;
    }

    requestLevel(index: number): void {
        if (!this.manager) return;
        this.manager.request(index);
        // Nothing on its way, for instance while Shaka waits for the buffer to
        // drain below its goal: nothing can be thrown away, so apply it now,
        // and the next fetch uses it. Otherwise 'segmentappended' applies it.
        if (!this.videoInFlight) this.manager.applyPending();
    }

    setLevel(index: number): void {
        if (this.manager) {
            this.manager.pin(index < 0 ? null : index);
            return;
        }

        if (index < 0) {
            this.player.configure({ abr: { enabled: true } });
            return;
        }

        this.player.configure({ abr: { enabled: false } });
        const track = this.player.getVariantTracks().find((t) => t.id === this.ids[index]);
        if (track) this.player.selectVariantTrack(track, true);
    }

    get autoEnabled(): boolean {
        return this.manager
            ? this.manager.pinned === null
            : this.player.getConfiguration().abr.enabled;
    }

    selectAudio(id: number): void {
        const track = this.player.getAudioTracks()[id];
        // No safeMargin, so Shaka's default of 0: it clears all the old
        // language ahead of the playhead and starts again from there, which
        // stalled playback once per switch in Step 6. A margin keeps that many
        // seconds of the old language while the new one loads.
        if (track) this.player.selectAudioTrack(track);
    }

    selectText(id: number): void {
        // null unloads the subtitles; there's no separate "hide" in Shaka 5.
        this.player.selectTextTrack(id < 0 ? null : (this.player.getTextTracks()[id] ?? null));
        this.reportTracks();
    }

    private reportTracks(): void {
        const toInfo = (t: { language: string; label: string | null }, id: number): TrackInfo => ({
            id,
            language: t.language,
            label: t.label || t.language,
        });
        const audio = this.player.getAudioTracks();
        const text = this.player.getTextTracks();
        this.opts.onTracks({
            audio: audio.map(toInfo),
            text: text.map(toInfo),
            audioId: audio.findIndex((t) => t.active),
            textId: text.findIndex((t) => t.active),
        });
    }

    async destroy(): Promise<void> {
        this.video.removeEventListener("resize", this.onResize);
        await this.player.destroy();
    }

    private announce(entries: Entry[]): void {
        // setVariants can be called more than once; report the manifest once.
        if (this.announced) return;
        this.announced = true;

        this.ids = entries.map((e) => e.id);
        this.heights = entries.map((e) => e.height);
        const levels: LevelInfo[] = entries.map((e, index) => ({
            index,
            height: e.height,
            bitrateKbps: Math.round(e.bandwidth / 1000),
        }));
        // Shaka gives an AbrManager the variants of ONE audio language (the
        // one it opens with), and getAudioTracks() is empty until load()
        // finishes. The manifest has every variant in every language, each
        // language one audio stream shared by all the rungs. With DASH it's
        // readable here. With HLS it isn't yet: Shaka picks the opening
        // variant before it has read the media playlists, so it can fetch
        // only the ones it needs, and this counts the opening language
        // alone. The tracks event after load() lists them all.
        const variants = this.player.getManifest()?.variants ?? entries.map((e) => ({ audio: e.audioId === null ? null : { id: e.audioId } }));
        const audioTracks = new Set(variants.flatMap((v) => (v.audio ? [v.audio.id] : []))).size;

        this.opts.onManifest(levels, audioTracks);
    }

    /** Report the rung on screen, found by the decoded picture's height. */
    private reportShown(): void {
        const height = this.video.videoHeight;
        if (!height) return; // no frame decoded yet
        const index = this.heights.indexOf(height);
        if (index < 0 || index === this.lastReported) return;
        this.lastReported = index;
        this.opts.onSwitch(index);
    }
}