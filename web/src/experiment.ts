/**
 * Runs an ABR comparison in the page while you watch.
 *
 * Three things people get wrong when they run these by hand:
 *
 *  - Order. Running all sessions of one algorithm, then all of the next,
 *    means anything that changes over time (other traffic on your network,
 *    the CDN cache warming up) gets blamed on whichever algorithm happened to
 *    be running. Here, every round runs each algorithm once, in a newly
 *    shuffled order, so those changes spread evenly across all of them.
 *
 *  - Bad trials. A trial is thrown away and repeated if the tab was hidden or
 *    the measured network doesn't match the label. Those are problems with
 *    the test, not with the algorithm. Recording them would blame the
 *    algorithm for something it didn't do.
 *
 *  - Bookkeeping. Each trial is reported as soon as it ends, and the run
 *    finishes by printing the exact query for its results.
 */

import type { AbrAlgorithm } from "./abr";
import { reportSession } from "./beacon";
import { fetchAsset, manifestURL, play, drmConfig, startPlayback } from "./player";
import type { Asset, EngineName, Playback, PlayerEvent, Protocol } from "./player";
import type { QoESnapshot } from "./qoe";

export interface ExperimentConfig {
    assetId: string;
    /** The ?net= label. Every recorded trial carries it. */
    networkProfile: string;
    /** Every trial in a run uses this engine. Engines are compared across runs. */
    engine: EngineName;
    protocol: Protocol;
    algorithms: Record<string, AbrAlgorithm>;
    /** Sessions per algorithm. */
    rounds: number;
    signal: AbortSignal;
}

export interface ExperimentHooks {
    video: HTMLVideoElement;
    log(message: string, kind?: "" | "sw" | "er"): void;
    onEvent?(event: PlayerEvent): void;
    /** Called as each trial starts and ends, so the page can show live numbers. */
    onPlayback(playback: Playback | null): void;
}

export interface ExperimentSummary {
    recorded: number;
    discarded: number;
    timedOut: number;
    aborted: boolean;
    /** A terminal command that prints this run's results. */
    command: string;
}

type Outcome = "ended" | "failed" | "timeout" | "hidden" | "aborted";

type TrialResult =
    | { kind: "ok"; snapshot: QoESnapshot }
    | { kind: "discarded"; reason: string }
    | { kind: "aborted" };

interface TrialContext {
    asset: Asset;
    networkProfile: string;
    engine: EngineName;
    protocol: Protocol;
    timeoutMs: number;
    hooks: ExperimentHooks;
    signal: AbortSignal;
}

/** No throttle delivers this. A reading above it means the browser cache served the segment. */
const CACHE_SUSPECT_KBPS = 50_000;

/**
 * Discards allowed for one trial before the run stops. Failing the same check
 * repeatedly is almost always the setup (cache on, wrong throttle) rather than
 * bad luck, and retrying forever would waste the run.
 */
const MAX_DISCARDS_PER_TRIAL = 2;

const PAUSE_BETWEEN_TRIALS_MS = 2000;

export async function runExperiment(
    config: ExperimentConfig,
    hooks: ExperimentHooks,
): Promise<ExperimentSummary> {
    const { log } = hooks;
    const { signal, networkProfile } = config;

    const asset = await fetchAsset(config.assetId);
    const ctx: TrialContext = {
        asset,
        networkProfile,
        engine: config.engine,
        protocol: config.protocol,
        // Long enough for a slow network to finish with heavy rebuffering,
        // short enough that a stuck session doesn't hold up the whole run.
        timeoutMs: ((asset.duration_s ?? 60) * 5 + 60) * 1000,
        hooks,
        signal,
    };

    const names = Object.keys(config.algorithms);
    const plan: string[] = [];
    for (let round = 0; round < config.rounds; round++) plan.push(...shuffled(names));

    log(`plan: ${config.rounds} rounds × ${names.length} algorithms = ${plan.length} trials on "${networkProfile}" with ${config.engine} · ${config.protocol}`);
    log(`order: ${plan.join(", ")}`);

    // Warm-up, not recorded. Two purposes:
    //  - It loads this asset into the CDN's edge cache, so recorded trials all
    //    see the same CDN state, instead of the first one paying for fetches
    //    from R2.
    //  - It checks your setup before the run starts. If the cache is on or
    //    the throttle doesn't match the label, you find out in the first
    //    minute, not after fifteen.
    log("warm-up (not recorded)…");
    const warm = await runTrial(ctx, config.algorithms[names[0]], "warmup");
    if (warm.kind === "discarded") throw new Error(`warm-up failed the setup check: ${warm.reason}`);

    // Set AFTER the warm-up, so the printed query can't include it.
    const startedAt = new Date().toISOString();
    let recorded = 0;
    let discarded = 0;
    let timedOut = 0;

    const summary = (aborted: boolean): ExperimentSummary => ({
        recorded,
        discarded,
        timedOut,
        aborted,
        command: resultsCommand(networkProfile, startedAt),
    });

    if (warm.kind === "aborted") return summary(true);

    for (let i = 0; i < plan.length; i++) {
        const name = plan[i];
        let discards = 0;

        for (;;) {
            await whenVisible(signal, log);
            if (signal.aborted) return summary(true);

            log(`trial ${i + 1}/${plan.length}: ${name}${discards ? ` (retry ${discards})` : ""}`, "sw");
            const result = await runTrial(ctx, config.algorithms[name], networkProfile);

            if (result.kind === "aborted") return summary(true);

            if (result.kind === "ok") {
                reportSession(result.snapshot);
                recorded++;
                if (result.snapshot.fatalError === "timeout") timedOut++;
                logResult(result.snapshot, log);
                break;
            }

            discarded++;
            discards++;
            log(`  discarded: ${result.reason}`, "er");
            if (discards > MAX_DISCARDS_PER_TRIAL) {
                throw new Error(`stopped after ${discards} discards in a row. Last reason: ${result.reason}`);
            }
        }

        await sleep(PAUSE_BETWEEN_TRIALS_MS, signal);
    }

    return summary(false);
}

async function runTrial(ctx: TrialContext, algorithm: AbrAlgorithm, label: string): Promise<TrialResult> {
    const { video } = ctx.hooks;

    // Playback speed changes how fast the buffer drains, so every trial runs
    // at normal speed, whatever the player was last set to.
    video.playbackRate = 1;

    // A fresh playback per trial: a run outlasts a playback token's 30
    // minutes, and every real viewer starts with new credentials too.
    const info = await startPlayback(ctx.asset.asset_id);
    const playback = play(video, {
        asset: ctx.asset,
        url: manifestURL(info, ctx.protocol),
        engine: ctx.engine,
        protocol: ctx.protocol,
        abr: algorithm,
        networkProfile: label,
        drm: drmConfig(info),
        onEvent: ctx.hooks.onEvent,
    });
    ctx.hooks.onPlayback(playback);

    const outcome = await waitForOutcome(video, playback, ctx.timeoutMs, ctx.signal);

    // A timeout is a real result, so it's recorded rather than discarded, but
    // marked so you can see it and filter it out if you want.
    if (outcome === "timeout") playback.session.failed("timeout");

    const snapshot = playback.session.snapshot();
    ctx.hooks.onPlayback(null);
    await playback.destroy();

    if (outcome === "aborted") return { kind: "aborted" };
    if (outcome === "hidden") {
        return { kind: "discarded", reason: "the tab was hidden; browsers hold back media in background tabs" };
    }

    const problem = checkNetwork(snapshot, ctx.networkProfile);
    if (problem) return { kind: "discarded", reason: problem };

    return { kind: "ok", snapshot };
}

/**
 * Does the network the player measured match what the label says?
 *
 * This is where the measured_throughput_kbps column from Milestone 9 earns its
 * place: the runner checks the label against reality on every trial, instead
 * of you finding a mismatch in the table afterwards.
 *
 * The tolerance is wide on purpose. Video downloads share the link with audio,
 * and TCP needs a moment to reach full speed, so the measurement normally
 * comes in somewhat under the throttle. The check is only meant to catch a
 * wrong setup, not small variations.
 */
function checkNetwork(snapshot: QoESnapshot, profile: string): string | null {
    const measured = snapshot.measuredThroughputKbps;
    if (measured === null) return null; // nothing downloaded; the session's own error will show

    if (measured > CACHE_SUSPECT_KBPS) {
        return `measured ${measured} kbps, which only the browser cache delivers. Tick "Disable cache" and keep DevTools open`;
    }

    // Only labels like "2500k" state a speed. For others, like "slow4g",
    // there's nothing exact to compare against.
    const declared = /^(\d+)k$/i.exec(profile);
    if (!declared) return null;

    const ratio = measured / Number(declared[1]);
    if (ratio > 1.5 || ratio < 0.5) {
        return `measured ${measured} kbps against a "${profile}" label. Check the throttle setting`;
    }
    return null;
}

function waitForOutcome(
    video: HTMLVideoElement,
    playback: Playback,
    timeoutMs: number,
    signal: AbortSignal,
): Promise<Outcome> {
    return new Promise((resolve) => {
        const undo: (() => void)[] = [];
        let done = false;

        const finish = (outcome: Outcome) => {
            if (done) return;
            done = true;
            undo.forEach((f) => f());
            resolve(outcome);
        };

        const listen = (target: EventTarget, type: string, fn: () => void) => {
            target.addEventListener(type, fn);
            undo.push(() => target.removeEventListener(type, fn));
        };

        listen(video, "ended", () => finish("ended"));
        listen(document, "visibilitychange", () => {
            if (document.visibilityState === "hidden") finish("hidden");
        });
        listen(signal, "abort", () => finish("aborted"));

        const timer = window.setTimeout(() => finish("timeout"), timeoutMs);
        undo.push(() => window.clearTimeout(timer));

        // Two things have no reliable event, so check them: a fatal error,
        // which the session records, and the end of the content, which the
        // session detects itself (see reachedEnd in player.ts) because the
        // browser's `ended` event may never fire.
        const poll = window.setInterval(() => {
            if (playback.session.snapshot().fatalError) finish("failed");
            else if (playback.session.hasEnded) finish("ended");
        }, 500);
        undo.push(() => window.clearInterval(poll));

        if (signal.aborted) finish("aborted");
    });
}

function whenVisible(signal: AbortSignal, log: ExperimentHooks["log"]): Promise<void> {
    if (document.visibilityState === "visible" || signal.aborted) return Promise.resolve();
    log("paused: waiting for this tab to be visible again", "er");
    return new Promise((resolve) => {
        const check = () => {
            if (document.visibilityState !== "visible" && !signal.aborted) return;
            document.removeEventListener("visibilitychange", check);
            signal.removeEventListener("abort", check);
            resolve();
        };
        document.addEventListener("visibilitychange", check);
        signal.addEventListener("abort", check);
    });
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        const timer = window.setTimeout(done, ms);
        function done() {
            window.clearTimeout(timer);
            signal.removeEventListener("abort", done);
            resolve();
        }
        signal.addEventListener("abort", done);
    });
}

/**
 * Fisher–Yates shuffle: every order is equally likely.
 *
 * The common shortcut, items.sort(() => Math.random() - 0.5), is NOT fair. The
 * sort algorithm compares items in a pattern that makes some orders more
 * likely than others, which for an experiment means some algorithms would
 * tend to run in the same positions.
 */
function shuffled<T>(items: T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
}

function logResult(s: QoESnapshot, log: ExperimentHooks["log"]): void {
    const startup = s.startupMs === null ? "—" : `${s.startupMs}ms`;
    log(
        `  startup ${startup} · rebuffer ${(s.rebufferRatio * 100).toFixed(1)}% · ` +
            `avg ${s.averageBitrateKbps ?? "—"}k · net ${s.measuredThroughputKbps ?? "—"}k` +
            (s.fatalError ? ` · ${s.fatalError}` : ""),
    );
}

/**
 * The command for this run's results, limited by label and start time so no
 * earlier session is included. The server and the browser are on the same
 * machine, so their clocks agree and the time filter is exact.
 */
function resultsCommand(profile: string, since: string): string {
    const label = profile.replace(/'/g, "''");
    const sql = [
        "SELECT engine, protocol, abr_algorithm, count(*) AS sessions,",
        "percentile_disc(0.5) WITHIN GROUP (ORDER BY startup_ms) AS p50_startup,",
        "percentile_disc(0.95) WITHIN GROUP (ORDER BY startup_ms) AS p95_startup,",
        "round(100.0 * sum(rebuffer_ms) / nullif(sum(playing_ms + rebuffer_ms), 0), 2) AS rebuffer_pct,",
        "round(avg(average_bitrate_kbps)) AS avg_kbps,",
        "percentile_disc(0.5) WITHIN GROUP (ORDER BY measured_throughput_kbps) AS net_kbps,",
        "round(avg(switch_up_count + switch_down_count), 1) AS avg_switches",
        `FROM playback_sessions WHERE network_profile = '${label}' AND created_at >= '${since}'`,
        "GROUP BY engine, protocol, abr_algorithm ORDER BY engine, protocol, abr_algorithm;",
    ].join(" ");
    return `docker compose exec -T db psql -U fastforge -c "${sql}"`;
}