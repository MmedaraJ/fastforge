import Hls from "hls.js";
import type { Engine, EngineOptions, LevelInfo, TrackInfo } from "./types";

export class HlsJsEngine implements Engine {
    // autoStartLoad: false, so hls.js reads the manifest and then waits for
    // start(). That's how the opening level gets chosen deliberately.
    private readonly hls = new Hls({ autoStartLoad: false });
    private readonly video;
    private readonly opts: EngineOptions;

    constructor(video: HTMLVideoElement, opts: EngineOptions) {
        this.video = video;
        this.opts = opts;
        const { hls } = this;

        // Subtitles start off until the viewer turns them on. hls.js shows a
        // subtitle track marked DEFAULT=YES straight away, as RFC 8216 says a
        // player should. Your pipeline marks none that way since Step 2, but
        // a manifest from anywhere else may.
        hls.subtitleDisplay = false;

        // The menus. hls.js fires AUDIO_TRACK_SWITCHED once a fragment of the
        // new language is buffered at the playhead (checkFragmentChanged in
        // hls.js 1.7). That's before it's heard: in Step 6 the switch was
        // reported 450 ms after the press and heard after 821.
        hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, () => this.reportTracks());
        hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, () => this.reportTracks());
        hls.on(Hls.Events.AUDIO_TRACK_SWITCHED, () => this.reportTracks());
        hls.on(Hls.Events.SUBTITLE_TRACK_SWITCH, () => this.reportTracks());

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

    selectAudio(id: number): void {
        // nextAudioTrack, not audioTrack. nextAudioTrack keeps playing the
        // old language until the new one's first fragment is buffered, then
        // cuts the old one 0.25 s ahead of the playhead
        // (nextAudioTrackBufferFlushForwardOffset). audioTrack flushes all
        // the old audio at once, and playback waits for the new language.
        this.hls.nextAudioTrack = id;
    }

    selectText(id: number): void {
        this.hls.subtitleTrack = id;
        this.hls.subtitleDisplay = id >= 0;
        this.reportTracks();
    }

    private reportTracks(): void {
        const { hls } = this;
        const toInfo = (t: { lang?: string; name: string }, id: number): TrackInfo => ({
            id,
            language: t.lang ?? "",
            label: t.name || (t.lang ?? ""),
        });
        this.opts.onTracks({
            audio: hls.audioTracks.map(toInfo),
            text: hls.subtitleTracks.map(toInfo),
            audioId: hls.audioTrack,
            textId: hls.subtitleDisplay ? hls.subtitleTrack : -1,
        });
    }

    async destroy(): Promise<void> {
        this.hls.destroy();
    }
}