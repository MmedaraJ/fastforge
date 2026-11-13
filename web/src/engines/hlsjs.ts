import Hls, { type GenerateRequestFilterResult, type HlsConfig, type LevelKey } from "hls.js";
import type { DrmConfig, Engine, EngineOptions, LevelInfo, TrackInfo } from "./types";

/**
 * hls.js's DRM settings. It picks the key system from the playlist's
 * KEYFORMAT, asks EME for it, and posts the CDM's licence request to
 * licenseUrl; licenseXhrSetup adds the viewer's token to that request.
 */
function drmSettings(drm: DrmConfig | null): Partial<HlsConfig> {
    if (!drm) return {};
    const clearKey = drm.keySystem === "org.w3.clearkey";
    return {
        emeEnabled: true,
        // Keyed by key system name; hls.js types the key as its own enum.
        drmSystems: {
            [drm.keySystem]: { licenseUrl: drm.licenseUrl, generateRequest: clearKey ? keyIdsFromPlaylist : undefined },
        } as HlsConfig["drmSystems"],
        licenseXhrSetup: (xhr) => xhr.setRequestHeader("Authorization", `Bearer ${drm.token}`),
    };
}

/**
 * Clear Key's licence request, built from the key ID in the playlist.
 *
 * hls.js reads the key ID from a Clear Key KEY tag but finds no PSSH box
 * there (a Widevine KEY tag's URI is one), so it skips the request and waits
 * for the browser's "encrypted" event. That event comes when the init
 * segment is appended, and hls.js appends it along with the first media
 * segment: in Step 7 the licence went out 65-75 ms after the first video
 * segment had downloaded. A "keyids" request needs only the key ID, so with
 * it hls.js asks while the segment is still on its way.
 */
function keyIdsFromPlaylist(
    initDataType: string,
    initData: ArrayBuffer | null,
    { decryptdata }: { decryptdata: LevelKey },
): GenerateRequestFilterResult {
    if (initData || !decryptdata.keyId) return { initDataType, initData };
    const kid = btoa(String.fromCharCode(...decryptdata.keyId)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    return { initDataType: "keyids", initData: new TextEncoder().encode(JSON.stringify({ kids: [kid] })).buffer };
}

export class HlsJsEngine implements Engine {
    private readonly hls: Hls;
    private readonly video;
    private readonly opts: EngineOptions;

    constructor(video: HTMLVideoElement, opts: EngineOptions) {
        this.video = video;
        this.opts = opts;
        // autoStartLoad: false, so hls.js reads the manifest and then waits for
        // start(). That's how the opening level gets chosen deliberately.
        this.hls = new Hls({ autoStartLoad: false, ...drmSettings(opts.drm) });
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