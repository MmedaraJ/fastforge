import shaka from "shaka-player";
import type { Engine, EngineOptions, LevelInfo } from "./types";

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
    getNetworkingEngine(): {
        registerResponseFilter(filter: (type: number, response: ShakaResponse) => void): void;
    } | null;
    addEventListener(type: string, listener: (event: Event) => void): void;
}

const SEGMENT_REQUEST: number = shaka.net.NetworkingEngine.RequestType.SEGMENT;
const CRITICAL: number = shaka.util.Error.Severity.CRITICAL;

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

    /** player.ts's choice for upcoming segments. */
    request(index: number): void {
        const target = this.variants[this.pinned ?? index];
        if (!target || target === this.current || !this.switchTo) return;
        this.current = target;
        // false = keep what's already buffered and switch from the next
        // segment, which is what hls.js's nextAutoLevel does too.
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
    private announced = false;
    private lastReported = -1;
    private readonly video: HTMLVideoElement;
    private readonly opts: EngineOptions

    constructor(video: HTMLVideoElement, opts: EngineOptions) {
        this.video = video;
        this.opts = opts;
        this.player = new shaka.Player() as unknown as ShakaPlayer;

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

        this.player.getNetworkingEngine()?.registerResponseFilter((type, response) => {
            if (type !== SEGMENT_REQUEST) return;

            // Unlike hls.js, Shaka doesn't give response filters a reliable,
            // version-stable way to tell audio from video. So this relies on
            // how YOUR packager lays out files: video under "<height>p/",
            // audio under "audio/", init segments named init.mp4.
            //
            // That's a real weakness and worth knowing about: the two engines
            // now decide "is this a video segment" differently. If your
            // packager's layout ever changes, this filter quietly starts
            // counting the wrong files. If the two engines' measured
            // throughput disagrees, check here first.
            if (response.uri.includes("/audio/") || response.uri.endsWith("init.mp4")) return;
            if (!response.timeMs) return;

            this.opts.onDownload(response.data.byteLength, response.timeMs / 1000);
        });

        // 'adaptation' fires when the ABR switches; 'variantchanged' fires on
        // a manual switch. Shaka reports these when the switch is DECIDED,
        // while hls.js reports LEVEL_SWITCHED a little later. So the two
        // engines' time-weighted average bitrates won't line up exactly.
        // Expect small differences from that alone.
        this.player.addEventListener("adaptation", () => this.reportActive());
        this.player.addEventListener("variantchanged", () => this.reportActive());

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
        this.reportActive();
    }

    start(openingLevel: number): void {
        // With the custom manager, this runs inside setVariants, just before
        // Shaka calls chooseVariant(). With built-in ABR, Shaka has already
        // started by the time this runs, so there's nothing to do.
        if (this.manager && openingLevel >= 0) this.manager.desired = openingLevel;
    }

    requestLevel(index: number): void {
        this.manager?.request(index);
    }

    setLevel(index: number): void {
        if (this.manager) {
            this.manager.pinned = index < 0 ? null : index;
            if (index >= 0) this.manager.request(index);
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

    async destroy(): Promise<void> {
        await this.player.destroy();
    }

    private announce(entries: Entry[]): void {
        // setVariants can be called more than once; report the manifest once.
        if (this.announced) return;
        this.announced = true;

        this.ids = entries.map((e) => e.id);
        const levels: LevelInfo[] = entries.map((e, index) => ({
            index,
            height: e.height,
            bitrateKbps: Math.round(e.bandwidth / 1000),
        }));
        const audioTracks = new Set(entries.map((e) => e.audioId).filter((id) => id !== null)).size;

        this.opts.onManifest(levels, audioTracks);
    }

    private reportActive(): void {
        const active = this.player.getVariantTracks().find((t) => t.active);
        if (!active) return;
        const index = this.ids.indexOf(active.id);
        if (index < 0 || index === this.lastReported) return;
        this.lastReported = index;
        this.opts.onSwitch(index);
    }
}