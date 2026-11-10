import type { LevelInfo } from "../player";

/**
 * Everything an ABR (Adaptive Bitrate) algorithm is allowed to see.
 *
 * Deliberately a plain value, not a reference to the player. An algorithm that
 * can reach into hls.js can't be unit-tested, can't be replayed against
 * recorded sessions, and quietly becomes coupled to one library. This shape is
 * the contract: if an algorithm needs something new, it goes here explicitly.
 */
export interface AbrInput {
    /** Sorted ascending by bitrate — index matches the player's level index. */
    levels: LevelInfo[];
    /** The rung on screen now, as the engine last reported it. */
    currentLevel: number;
    /**
     * The rung this algorithm asked for last time: -1 before its first choice.
     * It runs ahead of currentLevel, which only changes once the new rung
     * reaches the screen, up to a buffer's worth of seconds later. An algorithm
     * that compares against its own last choice (BOLA-O does) needs this one.
     */
    requestedLevel: number;
    /** Seconds of media buffered ahead of the playhead. */
    bufferSeconds: number;
    /** EWMA throughput estimate, or null before the first sample. */
    throughputKbps: number | null;
    segmentSeconds: number;
    /** At 2x, each rung costs twice its listed bitrate to sustain. */
    playbackRate: number;
}

export interface AbrAlgorithm {
    readonly name: string;
    /** True for the control arm: let the engine's built-in ABR decide. */
    readonly deferToEngine?: boolean;
    /** Returns a level index, or -1 to defer to the player's built-in ABR. */
    choose(input: AbrInput): number;
}

