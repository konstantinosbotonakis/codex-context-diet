import type { CacheEntry, TouchRecord } from './cache.js';
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
export type RecoveryClass = 'likely_recovery' | 'possible_rerun' | 'invalidated_rerun';
export interface RecoveryClassification {
    classification: RecoveryClass;
    because: string;
}
/**
 * How much weight a matched rerun deserves.
 *
 * The match itself only says the same call ran again. What happened in
 * between decides whether that reads as a lost result or as ordinary work:
 * a file that changed had to be read again whatever the diet did, and any
 * write in between makes a routine rerun indistinguishable from a recovery.
 */
export declare function classifyRecovery(entry: CacheEntry, current: {
    toolName: string;
    inputLine: string;
}, touches: readonly TouchRecord[]): RecoveryClassification;
export declare function detectRecovery(cache: CacheEntry[], alreadySeen: readonly string[], current: {
    toolName: string;
    inputLine: string;
}, now: number, windowMs: number): RecoveryMatch | null;
