import "./style.css";
import { fetchAsset, manifestURL, play } from "./player";
import type { Asset, Playback, PlayerEvent } from "./player";
import { reportOnExit, reportSession, sendBeacon } from "./beacon";
import { runExperiment } from "./experiment";
import type { QoESnapshot } from "./qoe";
import { ALGORITHMS } from "./abr";

const el = <T extends HTMLElement>(id: string): T =>
    document.getElementById(id) as T;

const assetInput = el<HTMLInputElement>("asset");
const levelSelect = el<HTMLSelectElement>("level");
const loadButton = el<HTMLButtonElement>("load");
const video = el<HTMLVideoElement>("v");
const logPanel = el<HTMLDivElement>("log");
const abrSelect = el<HTMLSelectElement>("abr");
/**
 * The network condition this tab is being tested under, from ?net=.
 *
 * The page has no way to see DevTools throttling. It runs in the network
 * stack, not in anything JavaScript can read, so the condition has to be
 * stated. Putting it in the URL means one bookmark per profile and no
 * dropdown to forget to change. The measured throughput tile is how you check
 * the label against reality.
 */
const networkProfile = new URLSearchParams(location.search).get("net");
const roundsInput = el<HTMLInputElement>("rounds");
const runButton = el<HTMLButtonElement>("run");
const stopButton = el<HTMLButtonElement>("stop");
const resultQuery = el<HTMLPreElement>("result-query");

let running: AbortController | null = null;
let playback: Playback | null = null;
let currentHeight: number | null = null;
let clockStart = 0;

for (const name of Object.keys(ALGORITHMS)) {
    const option = document.createElement("option");
    option.value = name;
    option.textContent = name;
    abrSelect.append(option);
}

// During a run, the runner reports its own trials. A trial cut short by
// closing the tab is incomplete, so it isn't reported.
reportOnExit(() => (running ? null : playback?.session.snapshot() ?? null));

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

/**
 * Report the current session, then tear it down. This is the bug fix: a
 * session ends when you load another one, not only when the page closes, and
 * every way a session can end has to report it.
 */
async function endCurrent(): Promise<void> {
    const previous = playback;
    playback = null;
    if (!previous) return;
    reportSession(previous.session.snapshot());
    await previous.destroy();
}

function setRunning(active: boolean): void {
    for (const control of [assetInput, abrSelect, levelSelect, loadButton, roundsInput, runButton]) {
        control.disabled = active;
    }
    stopButton.disabled = !active;
}

async function startExperiment(): Promise<void> {
    const assetId = assetInput.value.trim();
    if (!assetId) return log("enter an asset id first", "er");
    if (!networkProfile) {
        return log("open the page with ?net=<label> first. Results only compare within one labelled network", "er");
    }

    await endCurrent();
    logPanel.textContent = "";
    resultQuery.hidden = true;
    clockStart = 0;

    running = new AbortController();
    setRunning(true);

    try {
        const summary = await runExperiment(
            {
                assetId,
                networkProfile,
                algorithms: ALGORITHMS,
                rounds: Math.max(1, Number(roundsInput.value) || 5),
                signal: running.signal,
            },
            {
                video,
                log,
                onEvent: onPlayerEvent,
                onPlayback(p) {
                    playback = p;
                    currentHeight = null;
                    levelSelect.length = 1;
                    clockStart = p ? performance.now() : 0;
                },
            },
        );

        log(
            `${summary.aborted ? "stopped" : "done"}: ${summary.recorded} recorded, ${summary.discarded} discarded` +
                (summary.timedOut ? `, ${summary.timedOut} timed out` : ""),
            "sw",
        );
        resultQuery.textContent = summary.command;
        resultQuery.hidden = false;
    } catch (error) {
        log((error as Error).message, "er");
    } finally {
        running = null;
        setRunning(false);
    }
}

runButton.addEventListener("click", () => void startExperiment());
stopButton.addEventListener("click", () => running?.abort());

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
    set("tput", s.measuredThroughputKbps === null ? "—" : `${s.measuredThroughputKbps}k`);

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
    // A new load ENDS the previous session. The beacon only fires on page
    // exit, so without this the outgoing QoESession is discarded the moment
    // `playback` is reassigned — every session measured and then lost.
    //
    // This is also how a feed-style player behaves: swiping to the next item
    // ends one session and begins another, with no page navigation anywhere.
    await endCurrent();
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

    if (networkProfile) {
        log(`network profile: ${networkProfile}`);
    } else {
        log("no ?net= label: this session won't appear in the comparison", "er");
    }

    playback = play(video, {
        asset,
        url,
        abr: ALGORITHMS[abrSelect.value],
        networkProfile,
        onEvent: onPlayerEvent,
    });
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