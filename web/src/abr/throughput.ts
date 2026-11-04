import type { AbrAlgorithm, AbrInput } from "./types";

export interface ThroughputOptions {
    /** Fraction of estimated throughput a rung may use before we climb to it. */
    upFactor?: number;
    /** Fraction above which we drop. Looser, because dropping is cheap. */
    downFactor?: number;
}

/**
 * The classic rate-based rule: pick the best rung the measured network can pay
 * for, with a safety margin.
 *
 * Two asymmetries, and both exist because a rebuffer costs far more than a soft
 * picture:
 *
 *  - upFactor 0.7 means a rung must cost less than 70% of the estimate before
 *    we climb to it — effectively demanding 1.4x headroom. downFactor 0.9 means
 *    we bail the moment a rung costs more than 90%. Reluctant up, eager down.
 *
 *  - Climbing happens ONE rung at a time while dropping goes straight to the
 *    bottom affordable rung. Jumping 480p -> 1080p on one good sample is how
 *    players oscillate; falling 1080p -> 480p in one step is how they survive.
 */
export function throughputAbr({
    upFactor = 0.7,
    downFactor = 0.9,
}: ThroughputOptions = {}): AbrAlgorithm {
    return {
        name: "throughput",

        choose({ levels, currentLevel, throughputKbps, playbackRate }: AbrInput): number {
            // No measurement yet. Start at the bottom — the opening guess is
            // the single biggest lever on startup time, and your own data
            // showed a wrong guess costing 40 seconds on a slow link.
            if (throughputKbps === null) return 0;

            const affordableAt = (factor: number): number => {
                let best = 0;
                for (const level of levels) {
                    if (level.bitrateKbps * playbackRate <= throughputKbps * factor) best = level.index;
                }
                return best;
            };

            const floor = affordableAt(downFactor);
            if (floor < currentLevel) return floor; // drop all the way, now

            const ceiling = affordableAt(upFactor);
            return ceiling > currentLevel ? currentLevel + 1 : currentLevel;
        },
    };
}