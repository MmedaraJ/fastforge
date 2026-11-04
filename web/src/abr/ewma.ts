/**
 * Exponentially weighted moving average over time, not over sample count.
 *
 * Weighting by elapsed time rather than by "last N samples" matters because
 * segment downloads are not evenly spaced. Ten quick 240p segments and one slow
 * 1080p segment are not eleven equal opinions about the network — the long one
 * observed it for longer and deserves more weight.
 */
export class Ewma {
    private estimate = 0;
    private totalWeight = 0;
    private readonly halfLifeSeconds: number;

    constructor(halfLifeSeconds: number) {
        this.halfLifeSeconds = halfLifeSeconds;
    }

    sample(weightSeconds: number, value: number): void {
        // α is how much of the past you keep. 
        // α = 0.5 → keep half the old estimate.
        // Near 1 = keep the history completely, almost no time has passed; 
        // near 0 = a lot of time has passed, mostly discard history (stale).
        const alpha = Math.pow(0.5, weightSeconds / this.halfLifeSeconds);
        this.estimate = value * (1 - alpha) + alpha * this.estimate;
        this.totalWeight += weightSeconds;
    }

    get value(): number | null {
        if (this.totalWeight === 0) return null;

        // Zero-bias correction, and it is not optional.
        //
        // The estimate starts at 0, so early samples are averaged against a
        // zero that was never a measurement. Without this, the first segment on
        // a 10 Mbps link reports ~3 Mbps and the player opens three rungs too
        // low — a startup penalty on literally every session. Dividing by the
        // total weight actually accumulated removes the phantom zero.
        const zeroFactor = 1 - Math.pow(0.5, this.totalWeight / this.halfLifeSeconds);
        return this.estimate / zeroFactor;
    }
}

/**
 * Two estimators, and the answer is the pessimistic one.
 *
 * The fast estimator notices a collapse within a couple of segments. The slow
 * one ignores a single lucky cache hit. Taking the MINIMUM means: believe bad
 * news immediately, believe good news only once it persists.
 *
 * That asymmetry is the same one you saw in hls.js's switch behaviour — but
 * here it lives in the ESTIMATOR rather than the chooser, which is cleaner.
 * An over-optimistic estimate causes a rebuffer; an over-cautious one costs
 * some sharpness. Those are not equally bad, so the machinery should not treat
 * them symmetrically at any layer.
 */
export class ThroughputEstimator {
    private readonly fast = new Ewma(2);
    private readonly slow = new Ewma(8);

    /** bytes downloaded over seconds elapsed. */
    record(bytes: number, seconds: number): void {
        if (seconds <= 0 || bytes <= 0) return;
        const kbps = (bytes * 8) / 1000 / seconds;
        this.fast.sample(seconds, kbps);
        this.slow.sample(seconds, kbps);
    }

    get kbps(): number | null {
        const f = this.fast.value;
        const s = this.slow.value;
        if (f === null || s === null) return null;
        return Math.min(f, s);
    }
}