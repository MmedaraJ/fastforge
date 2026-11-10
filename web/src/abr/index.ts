import type { AbrAlgorithm } from "./types";
import { throughputAbr } from "./throughput";
import { bolaLite } from "./bola";

const builtIn: AbrAlgorithm = {
    name: "engine-default",
    deferToEngine: true,
    choose: () => -1,
};

export const ALGORITHMS: Record<string, AbrAlgorithm> = {
    "engine-default": builtIn,
    throughput: throughputAbr(),
    bola: bolaLite(),
    // The same BOLA, plus dash.js's guard against oscillation. A separate name,
    // not a change to "bola", so sessions recorded before keep meaning what
    // they meant, and one run puts the two side by side. Every entry here is
    // an arm of the experiment runner: four arms is 20 trials at 5 rounds.
    "bola-o": bolaLite({ name: "bola-o", avoidOscillation: true }),
};

export type { AbrAlgorithm, AbrInput } from "./types";