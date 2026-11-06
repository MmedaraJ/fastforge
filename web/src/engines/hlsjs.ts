import Hls from "hls.js";
import type { Engine, EngineOptions, LevelInfo } from "./types";

export class HlsJsEngine implements Engine {
    // autoStartLoad: false, so hls.js reads the manifest and then waits for
    // start(). That's how the opening level gets chosen deliberately.
    private readonly hls = new Hls({ autoStartLoad: false });
    private readonly video;

    constructor(video: HTMLVideoElement, opts: EngineOptions) {
        this.video = video
        const { hls } = this;

        hls.on(Hls.Events.MANIFEST_PARSED, (_, data) => {
            // hls.js already sorts levels by bitrate, lowest first, so its
            // indices match ours directly.
            const levels: LevelInfo[] = data.levels.map((l, index) => ({
                index,
                height: l.height,
                bitrateKbps: Math.round(l.bitrate / 1000),
            }));
            opts.onManifest(levels, data.audioTracks?.length ?? 0);
        });

        hls.on(Hls.Events.LEVEL_SWITCHED, (_, data) => opts.onSwitch(data.level));

        hls.on(Hls.Events.FRAG_LOADED, (_, data) => {
            // hls.js labels each fragment with its type, so filtering out audio
            // and init segments is exact. Compare this with Shaka below, where
            // it isn't.
            if ((data.frag.type as string) !== "main") return;
            if (data.frag.sn === "initSegment") return;
            const s = data.frag.stats;
            opts.onDownload(s.total, (s.loading.end - s.loading.start) / 1000);
        });

        hls.on(Hls.Events.ERROR, (_, data) =>
            opts.onError(`hlsjs/${data.type}/${data.details}`, data.fatal),
        );
    }

    async load(url: string): Promise<void> {
        // hls.js needs MSE. Without it, attachMedia() silently does nothing:
        // in hls.js 1.7.4 the setup code runs only `if (MediaSource)`, with no
        // else branch. No error, no playback, a session stuck in "starting".
        // Checking first turns that into an error the session records.
        if (!Hls.isSupported()) throw new Error("hlsjs: no usable Media Source Extensions in this browser");
        this.hls.loadSource(url);
        this.hls.attachMedia(this.video);
    }

    start(openingLevel: number): void {
        if (openingLevel >= 0) this.hls.startLevel = openingLevel;
        this.hls.startLoad();
    }

    // The setter style: hls.js's own ABR keeps running, and this overrides its
    // choice for the next fragment.
    requestLevel(index: number): void {
        if (this.hls.autoLevelEnabled) this.hls.nextAutoLevel = index;
    }

    setLevel(index: number): void {
        this.hls.currentLevel = index;
    }

    get autoEnabled(): boolean {
        return this.hls.autoLevelEnabled;
    }

    async destroy(): Promise<void> {
        this.hls.destroy();
    }
}