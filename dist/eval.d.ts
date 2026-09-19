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
    /** The raw model answers, when the caller asked for a dump (calibration). */
    answers?: Record<string, Record<string, number | string>>;
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
    /** Exact one-sided 95% upper bound on the false-drop rate for this sample. */
    falseDropUpper95: number;
}
export interface EvalReport {
    mode: 'offline' | 'live';
    /** The model asked in live mode, or null when the signals were simulated. */
    model: string | null;
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
    /** Record the raw answers for every case, for threshold calibration. */
    dump?: boolean;
}
export declare function runEvaluation(options?: EvalOptions): Promise<EvalReport>;
/**
 * Exact one-sided upper bound for the failure rate: the p where
 * P(X <= failures) equals 1 - confidence. Bisection over the binomial CDF,
 * so a zero-failure sample reports 1 - 0.05^(1/n) rather than zero risk.
 */
export declare function falseDropUpperBound(failures: number, cases: number, confidence?: number): number;
export declare function renderEvalReport(report: EvalReport): string;
