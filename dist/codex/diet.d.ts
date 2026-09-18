import type { CacheEntry } from '../cache.js';
import type { DietConfig } from '../config.js';
import type { JevAsker } from '../types.js';
export type DietAction = 'keep' | 'drop_result';
/**
 * The only reasons decideDiet produces, which means a Jev answer arrived. The
 * stats command counts these as Jev calls: every other reason is a path that
 * failed open before or during the request.
 */
export declare const JEV_REASONS: {
    readonly hazard: "hazard flagged; result kept and annotated";
    readonly needed: "contents still needed";
    readonly stale: "stale and reproducible, body omitted";
    readonly irreplaceable: "not reproducible, kept";
    readonly uncertain: "uncertain, kept";
};
export declare const JEV_REASON_VALUES: readonly string[];
export interface DietAnswers {
    /** The call happened and its arguments still matter, even if the body does not. */
    keepCall: number;
    /** The exact contents are still needed for the work ahead. */
    needsContents: number;
    /** The output can be produced again, or already exists elsewhere. */
    replaceable: number;
    /** Highest hazard probability, or null when the guard is off or unanswerable. */
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
 * Two thresholds, the TypeSafe guardrail shape: contents at or above
 * keepThreshold are needed, at or below dropThreshold they are not, and the
 * band between resolves to keep. A drop also requires the output to be
 * reproducible, so an uncertain answer can only ever cost tokens, never
 * information. A hazard verdict always keeps and annotates.
 */
export declare function decideDiet(answers: DietAnswers, config: DietConfig): DietDecision;
export declare function buildNote(input: DietInput, decision: DietDecision, config: DietConfig): string | null;
export declare function cacheEntryOf(input: DietInput, decision: DietDecision, at: string): CacheEntry;
export declare function runDiet(deps: DietDeps): Promise<DietOutcome>;
