import type { CacheEntry } from './cache.js';
/**
 * Approximate context pressure, owned by the plugin.
 *
 * Codex hook payloads carry no token or context usage, and the transcript
 * format is not a stable interface, so this is a conservative estimate of what
 * the session is carrying: every cached result counts whatever the model
 * actually kept for it, characters over four as tokens. It is a floor, not a
 * measurement, and it only ever lowers the size gate.
 */
export type PressureStage = 'low' | 'moderate' | 'high' | 'critical';
/** Retained-token marks for the stages. Fractions of a large context, not measurements. */
export declare const PRESSURE_THRESHOLDS: {
    readonly moderate: 40000;
    readonly high: 90000;
    readonly critical: 150000;
};
export declare function pressureStage(retained: number): PressureStage;
/** Characters the session is estimated to still be carrying. */
export declare function retainedChars(cache: CacheEntry[]): number;
export declare function retainedTokens(cache: CacheEntry[]): number;
