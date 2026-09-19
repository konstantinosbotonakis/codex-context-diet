import type { CacheEntry } from './cache.js';
/**
 * Recovery inference: a later call with the same tool and the same normalised
 * input, soon after a dropped result, most likely re-ran the tool because the
 * dropped contents were needed. The inference is deliberately loose and is
 * documented as an estimate: an intentional rerun looks the same from here.
 */
export interface RecoveryMatch {
    entry: CacheEntry;
    afterMs: number;
    /** How many cached calls landed between the drop and this call. */
    afterCalls: number;
}
/** Stable key for one tool plus one input, so a recovery scores once per input. */
export declare function inputKey(toolName: string, inputLine: string): string;
export declare function detectRecovery(cache: CacheEntry[], alreadySeen: readonly string[], current: {
    toolName: string;
    inputLine: string;
}, now: number, windowMs: number): RecoveryMatch | null;
