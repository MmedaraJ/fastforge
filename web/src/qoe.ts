/**
 * Quality-of-Experience measurement for one playback session.
 *
 * A state machine with a clock. Every transition charges elapsed time to the
 * state being LEFT, so each metric is simply a bucket that filled up. The hard
 * thinking lives in the transitions; the metrics then need no computation at
 * all — rebufferMs is just "time spent in the rebuffering state."
 *
 * This file knows nothing about the DOM, hls.js, or the network. It can run in
 * Node against a synthetic event sequence, which is how you test the
 * "a seek is not a rebuffer" rule without opening a browser.
 */

export type PlayerState =
  | "idle"        // nothing requested yet
  | "starting"    // manifest requested, no frame shown — this interval IS startup
  | "playing"     // frames reaching the viewer — the only state where bitrate counts
  | "paused"      // the viewer's own choice — excluded from every ratio
  | "rebuffering" // ran dry mid-playback — the only stall that counts against you
  | "seeking"     // user-initiated; absorbs the stall that follows a seek
  | "ended"
  | "failed";

export interface QoESnapshot {
  sessionId: string;
  assetId: string;
  startedAt: string;

  startupMs: number | null;      // null until the first frame renders
  playingMs: number;
  rebufferCount: number;
  rebufferMs: number;
  rebufferRatio: number;

  switchUpCount: number;         // separate on purpose — see above
  switchDownCount: number;
  switchCount: number;

  networkProfile: string | null;
  measuredThroughputKbps: number | null;

  averageBitrateKbps: number | null;
  droppedFrames: number;
  abrAlgorithm: string;

  engine: string;
  protocol: string;

  fatalError: string | null;
}

/** Who and what this session was. Named fields, so they can't be swapped silently. */
export interface SessionContext {
    assetId: string;
    abrAlgorithm: string;
    /** The ?net= label, or null if the tab wasn't given one. */
    networkProfile: string | null;
    engine: string;
    protocol: string;
}

const ZERO: Record<PlayerState, number> = {
  idle: 0, starting: 0, playing: 0, paused: 0,
  rebuffering: 0, seeking: 0, ended: 0, failed: 0,
};

export class QoESession {
    readonly sessionId = crypto.randomUUID();
    readonly startedAt = new Date().toISOString();
  
    private state: PlayerState = "idle";
  
    // The clock. lastMark is when the current interval began; timeInState is
    // where closed intervals go. Together they are every time-based metric.
    private lastMark = performance.now();
    private readonly timeInState = { ...ZERO };
  
    private requestedAt: number | null = null;
    private startupMs: number | null = null;
  
    // Average bitrate is an integral, not a mean, so we accumulate kbps·ms and
    // divide at the end. See levelChanged() and snapshot().
    private currentBitrateKbps = 0;
    private bitrateIntegral = 0;
    private lastLevel: number | null = null;
  
    private rebufferCount = 0;
    private switchUpCount = 0;
    private switchDownCount = 0;
    // getVideoPlaybackQuality().droppedVideoFrames is cumulative for the media
    // ELEMENT, not for this session. A player that reuses one <video> across
    // assets would otherwise carry each session's drops into the next.
    private droppedFramesBaseline: number | null = null;
    private droppedFrames = 0;
    private fatalError: string | null = null;
  
    private startupValid = true;

    // Total video bytes and total time spent downloading them. Dividing one by
    // the other at the end gives the link's average speed. It's a ratio of
    // sums, so a large slow segment counts for more than a tiny fast one.
    // Idle time between downloads is excluded, so this measures the network's
    // speed rather than how fast the video was consumed.
    private downloadedBytes = 0;
    private downloadSeconds = 0;

    readonly context: SessionContext;

    constructor(context: SessionContext) {
        this.context = context;
    }

    /**
     * The only place time is accounted for. Called before every state change,
     * every level change, and every snapshot — so no interval is ever lost,
     * double-counted, or charged to the wrong bucket.
     */
    private accrue(now: number): void {
        const dt = now - this.lastMark;
        this.lastMark = now;
        this.timeInState[this.state] += dt;

        // Bitrate only counts while frames are actually reaching the viewer.
        // Weighting by wall clock would let a long pause at 1080p inflate the
        // average forever.
        if (this.state === "playing") {
            this.bitrateIntegral += this.currentBitrateKbps * dt;
        }
    }

    private transition(to: PlayerState, now: number): void {
        this.accrue(now);
        this.state = to;
    }

    private get terminal(): boolean {
        return this.state === "ended" || this.state === "failed";
    }

    /** True once playback has reached the end of the content. */
    get hasEnded(): boolean {
        return this.state === "ended";
    }

    /** The viewer's clock starts at the manifest request. */
    requestStarted(now = performance.now()): void {
        this.requestedAt = now;
        this.transition("starting", now);
    }

    firstFrame(now = performance.now()): void {
        if (this.startupMs !== null || this.requestedAt === null) return;
        this.startupMs = now - this.requestedAt;
        this.transition("playing", now);
    }

    resumed(now = performance.now()): void {
        if (this.terminal) return;
        if (this.startupMs === null) return this.firstFrame(now);
        this.transition("playing", now);
    }

    stalled(now = performance.now()): void {
        // Before the first frame, an empty buffer is startup — counting it here
        // would charge the same milliseconds twice. During a seek, it is the cost
        // of something the viewer asked for and expects. Neither is a failure of
        // delivery, and neither belongs in this number.
        if (this.terminal) return;
        if (this.startupMs === null || this.state === "seeking") return;
    
        this.rebufferCount++;
        this.transition("rebuffering", now);
    }

    seeking(now = performance.now()): void {
        if (this.terminal) return;
        this.transition("seeking", now);
    }

    paused(now = performance.now()): void {
        // Guarded against terminal because some browsers fire 'pause' alongside
        // 'ended', which would otherwise reopen a finished session.
        if (this.terminal || this.startupMs === null) return;
        this.transition("paused", now);
    }

    ended(now = performance.now()): void {
        this.transition("ended", now);
    }

    failed(message: string, now = performance.now()): void {
        this.fatalError = message;
        this.transition("failed", now);
    }

    levelChanged(index: number, bitrateKbps: number, now = performance.now()): void {
        // Close the interval at the OLD bitrate before adopting the new one.
        this.accrue(now);
    
        if (this.lastLevel !== null && index !== this.lastLevel) {
            index > this.lastLevel ? this.switchUpCount++ : this.switchDownCount++;
        }
        this.lastLevel = index;
        this.currentBitrateKbps = bitrateKbps;
    }

    recordDroppedFrames(elementTotal: number): void {
        if (this.droppedFramesBaseline === null) {
            this.droppedFramesBaseline = elementTotal;
        }
        // max(0) because setting a new src resets the element's counter — without
        // it, a reset would produce a negative delta.
        this.droppedFrames = Math.max(0, elementTotal - this.droppedFramesBaseline);
    }

    /**
     * A startup time only describes the viewer's experience if the viewer was
     * there to experience it. If the tab is hidden before the first frame,
     * the browser may hold playback until it's visible again, and the clock
     * would measure how long someone was away rather than how fast the stream
     * started.
     *
     * Invalid is not the same as zero or as slow. The snapshot reports null,
     * and percentile_disc ignores nulls, so the session drops out of startup
     * statistics while its other metrics still count.
     */
    hiddenBeforeStart(): void {
        if (this.startupMs === null) this.startupValid = false;
    }

    recordDownload(bytes: number, seconds: number): void {
        if (seconds <= 0 || bytes <= 0) return;
        this.downloadedBytes += bytes;
        this.downloadSeconds += seconds;
    }

    /** Not pure: it closes the open interval first, which it must. */
    snapshot(now = performance.now()): QoESnapshot {
        this.accrue(now);

        const playingMs = this.timeInState.playing;
        const rebufferMs = this.timeInState.rebuffering;
        const tryingToWatch = playingMs + rebufferMs;

        return {
            sessionId: this.sessionId,
            assetId: this.context.assetId,
            startedAt: this.startedAt,
            startupMs: this.startupMs === null || !this.startupValid ? null : Math.round(this.startupMs),
            playingMs: Math.round(playingMs),
            rebufferCount: this.rebufferCount,
            rebufferMs: Math.round(rebufferMs),
            rebufferRatio: tryingToWatch === 0 ? 0 : rebufferMs / tryingToWatch,
            switchUpCount: this.switchUpCount,
            switchDownCount: this.switchDownCount,
            switchCount: this.switchUpCount + this.switchDownCount,

            // Time-weighted, not a mean of the levels visited. Play 1080p for one
            // second and 480p for fifty-nine and the viewer received a 480p
            // experience — (5000+1400)/2 answers "which rungs did I touch?", which
            // is not a question about experience. A correct average lands BETWEEN
            // your rungs, at a value that exists in no manifest. That is how you
            // know the integral is working.
            averageBitrateKbps: playingMs === 0 ? null : Math.round(this.bitrateIntegral / playingMs),

            droppedFrames: this.droppedFrames,
            abrAlgorithm: this.context.abrAlgorithm,
            networkProfile: this.context.networkProfile,
            measuredThroughputKbps:
                this.downloadSeconds === 0
                    ? null
                    : Math.round((this.downloadedBytes * 8) / 1000 / this.downloadSeconds),

            engine: this.context.engine,
            protocol: this.context.protocol,
            
            fatalError: this.fatalError,
        };
    }
}