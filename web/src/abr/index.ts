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
};

export type { AbrAlgorithm, AbrInput } from "./types";