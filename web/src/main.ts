import "./style.css";
import type { Asset, EngineName, Playback, PlayerEvent, Protocol, TrackInfo } from "./player";
import { reportOnExit, reportSession, sendBeacon } from "./beacon";
import { runExperiment } from "./experiment";
import type { QoESnapshot } from "./qoe";
import { ALGORITHMS } from "./abr";
import { CAN_SELECT_LEVEL, clearPreloaded, dropPreloaded, fetchAsset, manifestURL, 
    play, playsHlsNatively, preloadStart } from "./player";

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

// ---------------------------------------------------------------------
// Audio languages and subtitles (Milestone 13)
// ---------------------------------------------------------------------
const audioSelect = el<HTMLSelectElement>("audio");
const subsSelect = el<HTMLSelectElement>("subs");
/** What the log last said was heard and shown, so it reports only changes. */
let heardLabel = "";
let shownLabel = "";

/** Replace a menu's entries if the list changed, and select `active`. */
function fillMenu(select: HTMLSelectElement, tracks: TrackInfo[], active: number, offLabel?: string): void {
    const entries = [
        ...(offLabel ? [{ value: "-1", text: offLabel }] : []),
        ...tracks.map((t) => ({
            value: String(t.id),
            // "Tiếng Việt (vi)": the name for the viewer, the tag for you.
            text: t.language && trackName(t) !== t.language ? `${trackName(t)} (${t.language})` : trackName(t),
        })),
    ];
    const unchanged = select.options.length === entries.length &&
        entries.every((e, i) => select.options[i].value === e.value && select.options[i].textContent === e.text);
    if (!unchanged) {
        select.replaceChildren(...entries.map((e) => new Option(e.text, e.value)));
    }
    select.value = String(active);
}

/** A manifest may name a track, tag its language, or neither (your older assets). */
function trackName(t: TrackInfo): string {
    return t.label || t.language || "default";
}

function resetMenus(): void {
    audioSelect.replaceChildren();
    audioSelect.disabled = true;
    subsSelect.replaceChildren(new Option("subtitles off", "-1"));
    subsSelect.disabled = true;
    heardLabel = shownLabel = "";
}

/**
 * Asset records already looked up, by id. A real feed gets every item's
 * record with the feed; this page keeps each one it fetches, so going back to
 * a video doesn't wait on your API again. Only ready assets: one still
 * processing will have manifests later.
 */
const knownAssets = new Map<string, Asset>();

// ---------------------------------------------------------------------
// Feed mode (Milestone 12)
//
// ?feed=<id>,<id>,… plays those assets in order, one "next" press each, the
// way a short-video app moves through its feed ("previous" goes back). While
// one plays, the next is preloaded. ?preload=0 turns preloading off, for the
// cold comparison.
// ---------------------------------------------------------------------
const params = new URLSearchParams(location.search);
const feed = (params.get("feed") ?? "").split(",").map((id) => id.trim()).filter(Boolean);
const preloadEnabled = params.get("preload") !== "0";
const nextButton = el<HTMLButtonElement>("next");
const prevButton = el<HTMLButtonElement>("prev");
nextButton.hidden = prevButton.hidden = feed.length < 2;
let feedIndex = 0;

/**
 * Preloading shares the link with the video that's playing, so it waits
 * until that video can spare it: 10 s of buffer ahead. At 2500k the preload
 * took 7.6 s alongside playback and would take 3.8 s alone, so 10 s of
 * buffer outlasts it even if playback got none of the link meanwhile.
 */
const PRELOAD_AFTER_S = 10;

/**
 * A preload in progress, finished or failed. It keeps the asset's record
 * too, so pressing next doesn't look it up again, and its manifest URL, which
 * names its files in the preload store. A failed one stays, so it isn't
 * retried every 250 ms while its video is next.
 */
interface Preload {
    assetId: string;
    manifestUrl: string | null;
    controller: AbortController;
    asset: Asset | null;
    ready: boolean;
    failed: boolean;
}

/** Every preload kept, by asset id. */
const preloads = new Map<string, Preload>();

/**
 * How far along the feed from the video on screen a preload is kept: 2, not
 * 1. A viewer who goes back one video usually comes forward again, and the
 * video after the one they left is already downloaded. Dropped, it's
 * downloaded again, from the browser's HTTP cache if the cache still has it:
 * on Nov 10 that took under 3 s and the swipe forward still started in about
 * 40 ms. Kept, it doesn't depend on the cache.
 */
const KEEP_WITHIN = 2;

/** Steps between two feed positions, counting round the end (the feed wraps). */
function feedDistance(a: number, b: number): number {
    const d = Math.abs(a - b) % feed.length;
    return Math.min(d, feed.length - d);
}

function forget(p: Preload): void {
    p.controller.abort();
    if (p.manifestUrl) dropPreloaded(p.manifestUrl);
    preloads.delete(p.assetId);
}

function maybePreload(s: QoESnapshot): void {
    if (feed.length < 2 || !preloadEnabled || !playback) return;
    // Only your MSE engine reads the preload store.
    if (playback.engine !== "mse") return;
    const nextId = feed[(feedIndex + 1) % feed.length];
    if (preloads.has(nextId)) return;
    if (s.startupMs === null || bufferAhead() < PRELOAD_AFTER_S) return;
    void startPreload(nextId, selectedEngine().protocol);
}

async function startPreload(assetId: string, protocol: Protocol): Promise<void> {
    const controller = new AbortController();
    const mine: Preload = { assetId, manifestUrl: null, controller, asset: null, ready: false, failed: false };
    preloads.set(assetId, mine);
    const started = performance.now();
    log(`preloading next: ${assetId}`);
    try {
        const asset = knownAssets.get(assetId) ?? (await fetchAsset(assetId));
        if (asset.status === "ready") knownAssets.set(assetId, asset);
        mine.asset = asset;
        mine.manifestUrl = manifestURL(asset, protocol);
        const bytes = await preloadStart(mine.manifestUrl, controller.signal);
        if (preloads.get(assetId) !== mine) return;
        mine.ready = true;
        log(`preloaded ${assetId}: ${Math.round(bytes / 1000)} kB in ${((performance.now() - started) / 1000).toFixed(2)} s`);
    } catch (error) {
        if (controller.signal.aborted) return;
        log(`preload failed: ${(error as Error).message}`, "er");
        mine.failed = true;
        if (mine.manifestUrl) dropPreloaded(mine.manifestUrl);
    }
}

async function next(): Promise<void> {
    if (feed.length < 2) return;
    feedIndex = (feedIndex + 1) % feed.length;
    assetInput.value = feed[feedIndex];
    await load();
}

async function previous(): Promise<void> {
    if (feed.length < 2) return;
    feedIndex = (feedIndex - 1 + feed.length) % feed.length;
    assetInput.value = feed[feedIndex];
    await load();
}

const engineSelect = el<HTMLSelectElement>("engine");

// Engine and protocol are picked together, as one option. hls.js can't play
// DASH, so offering the two as separate dropdowns would let someone select a
// combination the code can't run. If the UI can only offer valid
// combinations, that mistake can't happen.
//
// "native" is listed only where the browser says it can play HLS by itself:
// Safari, and desktop Chrome since version 142. It's here so you can test the
// fallback on a Mac, where MSE exists and it would otherwise never run.
const ENGINE_CHOICES = [
    { value: "hlsjs:hls", label: "hls.js · HLS" },
    { value: "shaka:hls", label: "Shaka · HLS" },
    { value: "shaka:dash", label: "Shaka · DASH" },
    { value: "mse:hls", label: "fastforge MSE · HLS" },
    { value: "mse:dash", label: "fastforge MSE · DASH" },
    ...(playsHlsNatively(video) ? [{ value: "native:hls", label: "native · HLS" }] : []),
];

for (const choice of ENGINE_CHOICES) {
    const option = document.createElement("option");
    option.value = choice.value;
    option.textContent = choice.label;
    engineSelect.append(option);
}

function selectedEngine(): { engine: EngineName; protocol: Protocol } {
    const [engine, protocol] = engineSelect.value.split(":") as [EngineName, Protocol];
    return { engine, protocol };
}

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
    for (const control of [assetInput, abrSelect, engineSelect, levelSelect, loadButton, roundsInput, runButton]) {
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
    const { engine, protocol } = selectedEngine();
    if (!CAN_SELECT_LEVEL[engine]) {
        // Every trial would be recorded as engine-default, whatever the
        // algorithm: a comparison of the browser against itself.
        return log(`${engine} picks renditions itself, so your algorithms can't run on it`, "er");
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
                engine,
                protocol,
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

        case "tracks": {
            const { audio, text, audioId, textId } = event.tracks;
            fillMenu(audioSelect, audio, audioId);
            // One language is nothing to choose between.
            audioSelect.disabled = audio.length < 2;
            fillMenu(subsSelect, text, textId, "subtitles off");
            subsSelect.disabled = text.length === 0;
            // This event comes with the manifest and again with every change;
            // the log shows only what changed.
            const heardTrack = audio.find((t) => t.id === audioId);
            const shownTrack = text.find((t) => t.id === textId);
            const heard = heardTrack ? trackName(heardTrack) : "—";
            const shown = shownTrack ? trackName(shownTrack) : "off";
            if (heard !== heardLabel || shown !== shownLabel) log(`audio: ${heard} · subtitles: ${shown}`, "sw");
            heardLabel = heard;
            shownLabel = shown;
            break;
        }

        case "error":
            // Non-fatal errors are logged but not acted on — hls.js emits them
            // constantly while self-healing, and treating them as failures is
            // how a player dies where it would have recovered.
            log(`${event.detail}${event.fatal ? " (fatal)" : ""}`, "er");
            break;
    }
}

// Each load() takes a number. After every await it checks it's still the
// newest; if not, someone changed the asset or engine while it was waiting,
// and it stops. Without this, two overlapping loads both reach play(): two
// engines attach to the same <video>, and the first is never destroyed, so it
// keeps seeking and pausing a video that now belongs to the second.
let loadGeneration = 0;

async function load(): Promise<void> {
    const generation = ++loadGeneration;

    // A new load ENDS the previous session. The beacon only fires on page
    // exit, so without this the outgoing QoESession is discarded the moment
    // `playback` is reassigned — every session measured and then lost.
    //
    // This is also how a feed-style player behaves: swiping to the next item
    // ends one session and begins another, with no page navigation anywhere.
    await endCurrent();
    if (generation !== loadGeneration) return;
    currentHeight = null;
    clockStart = 0;
    logPanel.textContent = "";
    levelSelect.length = 1;
    levelSelect.value = "-1";
    levelSelect.disabled = false;
    resetMenus();

    const id = assetInput.value.trim();
    if (!id) return;

    // A preload for this asset is what the engine will now use, even if
    // it's still downloading: the engine waits for it rather than asking
    // twice. Preloads near this video in the feed stay, so going back and
    // forth doesn't throw away downloads the viewer will want again; any
    // further away are stopped and dropped.
    const reuse = preloads.get(id) ?? null;
    preloads.delete(id);
    const position = feed.indexOf(id);
    for (const p of [...preloads.values()]) {
        const other = feed.indexOf(p.assetId);
        if (position >= 0 && other >= 0 && feedDistance(position, other) <= KEEP_WITHIN) continue;
        forget(p);
    }
    const preloaded = reuse && !reuse.failed ? (reuse.ready ? "preloaded" : "preload still downloading") : null;

    const { engine, protocol } = selectedEngine();

    let asset: Asset;
    let url: string;
    try {
        // The preload already looked this asset up. A real feed gets each
        // item's URLs with the feed itself; looking it up again here is a
        // round trip the viewer would wait through for nothing.
        asset = (reuse?.failed ? null : reuse?.asset) ?? knownAssets.get(id) ?? (await fetchAsset(id));
        if (asset.status === "ready") knownAssets.set(id, asset);
        url = manifestURL(asset, protocol);
    } catch (error) {
        if (generation !== loadGeneration) return;
        log((error as Error).message, "er");
        return;
    }
    if (generation !== loadGeneration) return;

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

    if (preloaded) log(`${preloaded}: the first files come from memory`);

    playback = play(video, {
        asset,
        url,
        engine,
        protocol,
        abr: ALGORITHMS[abrSelect.value],
        networkProfile,
        onEvent: onPlayerEvent,
    });

    if (playback.engine !== engine) {
        log(`no Media Source Extensions here: the browser's own player took over from ${engine}`, "er");
    }
    // The labels this session will be recorded under, which can differ from
    // what the dropdowns say. Seeing them here is how you catch that.
    log(`engine: ${playback.engine} · ${protocol} · abr: ${playback.session.context.abrAlgorithm}`);

    // In native playback the browser picks every rendition. A level dropdown
    // that silently does nothing is worse than a disabled one.
    levelSelect.disabled = !playback.canSelectLevel;
}

// snapshot() closes the open interval and immediately reopens it, so polling it
// is safe and accumulates no error — the accrue() design is what makes a live
// readout and a final beacon the same code path.
window.setInterval(() => {
    if (!playback) return;
    const s = playback.session.snapshot();
    render(s);
    maybePreload(s);
}, 250);

loadButton.addEventListener("click", () => void load());
nextButton.addEventListener("click", () => void next());
prevButton.addEventListener("click", () => void previous());
// A different engine is a new session, like a new asset, so each recorded
// session belongs to exactly one engine. Preloads were made for the old
// engine's protocol, so they all go.
engineSelect.addEventListener("change", () => {
    for (const p of [...preloads.values()]) forget(p);
    clearPreloaded();
    void load();
});
assetInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void load();
});
levelSelect.addEventListener("change", () => {
    const index = Number(levelSelect.value);
    playback?.setLevel(index);
    log(index === -1 ? "level set to auto" : `level pinned to ${index}`);
});
audioSelect.addEventListener("change", () => {
    log(`audio: switching to ${audioSelect.selectedOptions[0]?.textContent ?? ""}`);
    playback?.selectAudio(Number(audioSelect.value));
});
subsSelect.addEventListener("change", () => playback?.selectText(Number(subsSelect.value)));

// ?asset=<id> loads immediately, so reloading after a code change costs nothing.
// So does ?feed=, starting at its first asset.
const fromQuery = params.get("asset") ?? feed[0] ?? null;
if (fromQuery) {
    assetInput.value = fromQuery;
    void load();
}