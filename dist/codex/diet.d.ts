import type { CacheEntry } from '../cache.js';
import type { DietConfig } from '../config.js';
import type { JevAsker } from '../types.js';
export type DietAction = 'keep' | 'drop_result';
export interface DietAnswers {
    keepCall: number;
    keepResult: number;
    injection: number | null;
}
export interface DietDecision extends DietAnswers {
    action: DietAction;
    reason: string;
}
export interface DietInput {
    toolName: string;
    toolUseId: string;
    inputLine: string;
    resultText: string;
    isError: boolean;
    goalIndex: number;
}
export interface DietOutcome {
    decision: DietDecision;
    note: string | null;
    warning: string | null;
    stdout: Record<string, unknown> | null;
    blocked: boolean;
    entry: CacheEntry;
}
export interface DietDeps {
    input: DietInput;
    config: DietConfig;
    cache: CacheEntry[];
    asker: JevAsker | null;
    goal: string;
    /** True only for the first result of a session that keeps a cache to reason against. */
    firstResult: boolean;
}
/**
 * The injection verdict forces keep: flagging content and then discarding the
 * head would hide the evidence. Both other outcomes replace the result.
 */
export declare function decideDiet(answers: DietAnswers, config: DietConfig): DietDecision;
export declare function buildNote(input: DietInput, decision: DietDecision, config: DietConfig): string | null;
export declare function cacheEntryOf(input: DietInput, decision: DietDecision, at: string): CacheEntry;
export declare function runDiet(deps: DietDeps): Promise<DietOutcome>;
