/**
 * The decision evaluation framework.
 *
 * Offline mode feeds each case the signals a correct Jev answer would give, so
 * the deterministic pipeline is tested for regressions without a network. Live
 * mode asks the real model and reports the same metrics plus tokens and cost.
 * Every fixture declares its expected action, and a false drop fails offline CI.
 */
export declare const EVAL_ROOT: string;
export interface EvalCase {
    id: string;
    category: string;
    goal: string;
    tool: string;
    input: string;
    fixture: string;
    expectedAction: 'keep' | 'drop';
    reason: string;
    /** The scores a correct Jev answer would return, for the offline run. */
    signals: Record<string, number>;
}
export interface EvalCaseResult {
    id: string;
    category: string;
    expected: 'keep' | 'drop';
    actual: 'keep' | 'drop';
    reason: string;
    resultChars: number;
    noteChars: number;
    inputTokens: number | null;
    ms: number;
}
export interface EvalMetrics {
    cases: number;
    correct: number;
    falseKeeps: number;
    falseDrops: number;
    dropPrecision: number;
    keepRecall: number;
    wrongDropRate: number;
    replacementRate: number;
    compressionMean: number;
    compressionMedian: number;
    jevCalls: number;
    jevTokens: number;
    estimatedCostUsd: number;
    p50Ms: number;
    p95Ms: number;
}
export interface EvalReport {
    mode: 'offline' | 'live';
    cases: EvalCaseResult[];
    metrics: EvalMetrics;
}
export declare function loadCases(root?: string): EvalCase[];
/** `{{FILL:n}}` becomes n benign lines, so a huge log stays a small fixture file. */
export declare function expandFixture(text: string): string;
export declare function readFixture(name: string, root?: string): string;
export interface EvalOptions {
    live?: boolean;
    env?: NodeJS.ProcessEnv;
    root?: string;
}
export declare function runEvaluation(options?: EvalOptions): Promise<EvalReport>;
export declare function renderEvalReport(report: EvalReport): string;
