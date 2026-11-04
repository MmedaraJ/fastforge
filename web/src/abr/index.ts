import type { AbrAlgorithm } from "./types";
import { throughputAbr } from "./throughput";
import { bolaLite } from "./bola";

/**
 * The control. Returning -1 means "defer to hls.js" — not "do nothing".
 *
 * A comparison without a control is an anecdote. This entry exists so the same
 * UI, the same QoE model and the same beacon record hls.js's own ABR, making it
 * genuinely comparable to yours rather than something you remember being
 * roughly like.
 */
const builtIn: AbrAlgorithm = { name: "hls-default", choose: () => -1 };

export const ALGORITHMS: Record<string, AbrAlgorithm> = {
    "hls-default": builtIn,
    throughput: throughputAbr(),
    bola: bolaLite(),
};

export type { AbrAlgorithm, AbrInput } from "./types";