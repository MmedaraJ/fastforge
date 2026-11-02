import "./style.css";
import { fetchAsset, manifestURL, play } from "./player";
import type { Asset, Playback, PlayerEvent } from "./player";
import { reportOnExit, sendBeacon } from "./beacon";
import type { QoESnapshot } from "./qoe";

const el = <T extends HTMLElement>(id: string): T =>
    document.getElementById(id) as T;

const assetInput = el<HTMLInputElement>("asset");
const levelSelect = el<HTMLSelectElement>("level");
const loadButton = el<HTMLButtonElement>("load");
const video = el<HTMLVideoElement>("v");
const logPanel = el<HTMLDivElement>("log");

let playback: Playback | null = null;
let currentHeight: number | null = null;
let clockStart = 0;

/**
 * Registered ONCE for the lifetime of the page, not per load.
 *
 * reportOnExit attaches pagehide and visibilitychange listeners. Calling it on
 * every load would stack a new pair each time, so one exit would fire a beacon
 * for every session ever played in this tab. The closure reads the CURRENT
 * playback when it fires, which is why a single registration covers them all.
 */
reportOnExit(() => playback?.session.snapshot() ?? null);

// Debug handle. Page-lifecycle events vary by browser and OS, so being able to
// fire a beacon on demand separates "is the transport working" from "did the
// trigger fire" — two failures that look identical from the outside.
(window as Window & { fastforge?: unknown }).fastforge = {
  snapshot: () => playback?.session.snapshot() ?? null,
  beacon: () => {
      const s = playback?.session.snapshot();
      if (s) sendBeacon(s);
      return s;
  },
};

type LogKind = "" | "sw" | "er";

function log(message: string, kind: LogKind = ""): void {
    const elapsed = clockStart
        ? ((performance.now() - clockStart) / 1000).toFixed(2).padStart(6)
        : "  0.00";

    // textContent, never innerHTML. Asset titles come from whoever uploaded the
    // file and error details come off the network — interpolating either into
    // markup is an injection vector in a page that will eventually be public.
    const line = document.createElement("div");
    const stamp = document.createElement("span");
    stamp.className = "t";
    stamp.textContent = `${elapsed}s  `;
    const body = document.createElement("span");
    body.className = kind;
    body.textContent = message;

    line.append(stamp, body);
    logPanel.append(line);
    logPanel.scrollTop = logPanel.scrollHeight;
}

function set(id: string, value: string, tone: "" | "good" | "warn" | "bad" = ""): void {
    const node = el(id);
    node.textContent = value;
    node.className = `v ${tone}`.trim();
}

function bufferAhead(): number {
    const ranges = video.buffered;
    for (let i = 0; i < ranges.length; i++) {
        if (video.currentTime >= ranges.start(i) && video.currentTime <= ranges.end(i)) {
            return ranges.end(i) - video.currentTime;
        }
    }
    return 0;
}

function render(s: QoESnapshot): void {
    // Session history — everything the QoE model has accumulated.
    set("startup",
        s.startupMs === null ? "—" : `${s.startupMs}ms`,
        s.startupMs === null ? "" : s.startupMs < 1000 ? "good" : "warn");
    set("avg", s.averageBitrateKbps === null ? "—" : `${s.averageBitrateKbps}k`);
    set("switches", `${s.switchUpCount}\u2191 ${s.switchDownCount}\u2193`);
    set("rebuffers", String(s.rebufferCount), s.rebufferCount === 0 ? "good" : "bad");
    set("ratio", `${(s.rebufferRatio * 100).toFixed(2)}%`,
        s.rebufferRatio === 0 ? "good" : s.rebufferRatio < 0.01 ? "warn" : "bad");
    set("dropped", String(s.droppedFrames));

    // Live state — what is true RIGHT NOW. Deliberately not from the snapshot:
    // "average bitrate over the session" and "the rung playing this instant"
    // are different questions, and showing one while labelling it the other is
    // how dashboards mislead the people reading them.
    const ahead = bufferAhead();
    const remaining = video.duration - video.currentTime;
    // Near the end there is nothing left to buffer, so a small number is
    // expected rather than alarming. Without this the tile goes red on every
    // successful playthrough — and a warning that always fires is a warning
    // nobody reads.
    const healthy = Number.isFinite(remaining) && ahead >= remaining - 0.5;
    set("buffer", `${ahead.toFixed(1)}s`,
        healthy ? "good" : ahead > 4 ? "good" : ahead > 1 ? "warn" : "bad");
    set("level-now", currentHeight === null ? "—" : `${currentHeight}p`);
}

function onPlayerEvent(event: PlayerEvent): void {
    switch (event.type) {
        case "manifest":
            log(`manifest parsed — ${event.levels.length} levels, ${event.audioTracks} audio track(s)`);
            for (const level of event.levels) {
                log(`  [${level.index}] ${String(level.height).padStart(4)}p  ` +
                    `${String(level.bitrateKbps).padStart(5)} kbps`);
                const option = document.createElement("option");
                option.value = String(level.index);
                option.textContent = `${level.height}p`;
                levelSelect.append(option);
            }
            break;

        case "switch":
            currentHeight = event.height;
            log(`\u2192 level ${event.index}  ${event.height}p  ${event.bitrateKbps} kbps`, "sw");
            break;

        case "error":
            // Non-fatal errors are logged but not acted on — hls.js emits them
            // constantly while self-healing, and treating them as failures is
            // how a player dies where it would have recovered.
            log(`${event.detail}${event.fatal ? " (fatal)" : ""}`, "er");
            break;
    }
}

async function load(): Promise<void> {
    playback?.destroy();
    playback = null;
    currentHeight = null;
    clockStart = 0;
    logPanel.textContent = "";
    levelSelect.length = 1;
    levelSelect.value = "-1";

    const id = assetInput.value.trim();
    if (!id) return;

    let asset: Asset;
    let url: string;
    try {
        asset = await fetchAsset(id);
        url = manifestURL(asset);
    } catch (error) {
        log((error as Error).message, "er");
        return;
    }

    log(`"${asset.title}" — ${asset.width}x${asset.height} ` +
        `${asset.fps}fps ${asset.duration_s?.toFixed(2)}s`);
    for (const r of asset.renditions) {
        log(`  ${String(r.height).padStart(4)}p  ${String(r.bitrate_kbps).padStart(5)} kbps  ` +
            `vmaf ${r.vmaf?.toFixed(2) ?? "—"}`);
    }

    // The clock starts HERE, at the manifest request — not at the metadata
    // fetch above. A real player already knows its URL, so timing our own API
    // lookup would inflate every startup number we record.
    clockStart = performance.now();
    log(`GET ${url}`);

    playback = play(video, asset, url, onPlayerEvent);
}

// snapshot() closes the open interval and immediately reopens it, so polling it
// is safe and accumulates no error — the accrue() design is what makes a live
// readout and a final beacon the same code path.
window.setInterval(() => {
    if (playback) render(playback.session.snapshot());
}, 250);

loadButton.addEventListener("click", () => void load());
assetInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void load();
});
levelSelect.addEventListener("change", () => {
    const index = Number(levelSelect.value);
    playback?.setLevel(index);
    log(index === -1 ? "level set to auto" : `level pinned to ${index}`);
});

// ?asset=<id> loads immediately, so reloading after a code change costs nothing.
const fromQuery = new URLSearchParams(location.search).get("asset");
if (fromQuery) {
    assetInput.value = fromQuery;
    void load();
}