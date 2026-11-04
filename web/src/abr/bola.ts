import type { AbrAlgorithm, AbrInput } from "./types";

export interface BolaOptions {
    /** Buffer level, in seconds, at which the top rung becomes attractive. */
    bufferTargetSeconds?: number;
    /** Weight on avoiding the bottom rung. Higher = less willing to go low. */
    gp?: number;
}

/**
 * Buffer-based selection, in the spirit of BOLA (Spiteri et al.).
 *
 * The idea that makes it work: THROUGHPUT IS REDUNDANT. If the network were
 * bad, the buffer would be draining — so buffer level already contains the
 * information, with none of the estimation error. This algorithm never looks at
 * throughputKbps at all.
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
 * Worked, with your ladder (1400/2800/5000) and 6s segments:
 *   buffer  0s  -> level 0   (nothing banked, take no risk)
 *   buffer 12s  -> level 2   (two segments of runway, go for it)
 *
 * The jump straight from 0 to 2 is characteristic of plain BOLA, and real
 * implementations add dwell-time and one-rung-at-a-time constraints on top.
 * Leave it unconstrained for now — you want to SEE the oscillation in your
 * switch counts before you decide it's a problem worth code.
 */
export function bolaLite({
    bufferTargetSeconds = 20,
    gp = 5,
}: BolaOptions = {}): AbrAlgorithm {
    return {
        name: "bola",

        choose({ levels, bufferSeconds, segmentSeconds, currentLevel }: AbrInput): number {
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

            return best;
        },
    };
}