import type { AbrAlgorithm, AbrInput } from "./types";

export interface BolaOptions {
    /** Buffer level, in seconds, at which the top rung becomes attractive. */
    bufferTargetSeconds?: number;
    /** Weight on avoiding the bottom rung. Higher = less willing to go low. */
    gp?: number;
    /** The name sessions are recorded under, so two variants never share one. */
    name?: string;
    /** BOLA-O: never climb to a rung the measured throughput can't sustain. */
    avoidOscillation?: boolean;
}

/**
 * Buffer-based selection, in the spirit of BOLA (Spiteri et al.).
 *
 * The idea that makes it work: THROUGHPUT IS REDUNDANT. If the network were
 * bad, the buffer would be draining — so buffer level already contains the
 * information, with none of the estimation error. Plain BOLA never looks at
 * throughputKbps at all. (BOLA-O, below, looks at it for one decision only.)
 *
 * Each rung gets a UTILITY, and the utility is logarithmic:
 *
 *     utility(i) = ln(bitrate[i] / bitrate[0])
 *
 * That log is not a mathematical convenience — it is the claim that quality has
 * diminishing returns in bitrate. You proved this on your own content: 480 to
 * 720 bought 8.2 VMAF points, 720 to 1080 bought 4.4 for nearly double the
 * bits. BOLA encodes that shape directly, which is why it refuses to spend the
 * top rung's bitrate unless the buffer is genuinely comfortable.
 *
 * The objective trades utility against buffer risk:
 *
 *     score(i) = (V * (utility(i) + gp) - Q) / bitrate[i]
 *
 * where Q is buffer measured in segments and V scales how much a segment of
 * buffer is worth relative to a unit of quality. Pick the highest score.
 *
 * With your declared rates (1528/2977/5231 kbps), gp = 5, a 20 s target and
 * 6 s segments, the switch points come out at 9.65 s of buffer (480p to 720p)
 * and 11.06 s (720p to 1080p): 720p wins across only 1.4 s of buffer.
 *
 * WHY PLAIN BOLA OSCILLATES. The buffer isn't steady: it jumps by 6 s when a
 * segment lands and drains by 1 s every second in between. Your Milestone 10
 * runs at 2500k measured about 2,000 kbps, which sits between 480p (1,528) and
 * 720p (2,977), and the buffer's swing crossed both switch points every
 * segment. Re-asked every 500 ms, BOLA answered "climb" just after each segment
 * landed and "drop" as the buffer drained: 6.8 changes of mind per 30 s session
 * on Shaka. In a reproduction of that run, not one of them reached the screen.
 *
 * BOLA-O is dash.js's fix. Its BolaRule.js puts it as "when network bandwidth
 * lies between two encoded bitrate levels, stick to the lowest level". When
 * BOLA wants to climb above its last choice, the climb is capped at the highest
 * rung the throughput estimate sustains, but never below that last choice.
 * Drops are left to BOLA. At 2500k that holds 480p; at your 4000k throttle
 * (3.1–3.5 Mbps measured) it allows 720p and stops short of 1080p.
 */
export function bolaLite({
    bufferTargetSeconds = 20,
    gp = 5,
    name = "bola",
    avoidOscillation = false,
}: BolaOptions = {}): AbrAlgorithm {
    return {
        name,

        choose({
            levels,
            bufferSeconds,
            segmentSeconds,
            currentLevel,
            requestedLevel,
            throughputKbps,
            playbackRate,
        }: AbrInput): number {
            if (levels.length === 0) return currentLevel;

            const base = levels[0].bitrateKbps;
            const utility = levels.map((l) => Math.log(l.bitrateKbps / base));
            const maxUtility = utility[utility.length - 1];

            const V = (bufferTargetSeconds / segmentSeconds - 1) / (maxUtility + gp);
            const Q = bufferSeconds / segmentSeconds;

            let best = levels[0].index;
            let bestScore = -Infinity;

            levels.forEach((level, i) => {
                const score = (V * (utility[i] + gp) - Q) / level.bitrateKbps;
                if (score > bestScore) {
                    bestScore = score;
                    best = level.index;
                }
            });

            // BOLA-O. Without a measurement there's nothing to cap against, and
            // with an empty buffer at startup BOLA picks the bottom rung anyway.
            if (avoidOscillation && throughputKbps !== null) {
                // BOLA's own last choice, not the rung on screen: the screen
                // lags by up to a buffer's worth of seconds.
                const last = requestedLevel >= 0 ? requestedLevel : currentLevel;

                // The highest rung this estimate can keep up with. No extra
                // margin: the estimate is already the lower of two averages,
                // and bitrateKbps is each rung's declared peak, not its average.
                let sustainable = levels[0].index;
                for (const level of levels) {
                    if (level.bitrateKbps * playbackRate <= throughputKbps) sustainable = level.index;
                }

                // Only a climb past both is capped, and never below the last choice.
                if (best > last && best > sustainable) best = Math.max(sustainable, last);
            }

            return best;
        },
    };
}
