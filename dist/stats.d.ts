export interface RawRecord {
    [key: string]: unknown;
}
export interface SessionData {
    sessionId: string;
    entries: RawRecord[];
}
export interface UsageInput {
    sessions: SessionData[];
    events: RawRecord[];
    now?: Date;
    /** Which data directories were read, for the header line. */
    stores?: string[];
    /** USD per million input tokens, read from the store config when it is there. */
    pricePerMillionInputTokens?: number;
}
export interface UsageWindow {
    label: string;
    start: number;
    sessions: number;
    judged: number;
    /** Event-log counts also cover decisions evicted from legacy rolling caches. */
    loggedDecisions: number;
    loggedReplacements: number;
    replaced: number;
    charsDropped: number;
    jevCalls: number;
    jevTokens: number;
    /** Jev calls in this window whose API response reported token usage. */
    jevMeasured: number;
    costUsd: number;
    guardRuns: number;
    guardFlags: number;
    keyWarnings: number;
    /** Results removed because the session already held an identical one. */
    deterministicDrops: number;
    /** Results the adapter looked at and left alone before any decision. */
    entries: number;
    skipped: number;
    keeps: number;
    neededKeeps: number;
    uncertainKeeps: number;
    irreplaceableKeeps: number;
    hazardKeeps: number;
    /** Drops decided by a Jev answer, as opposed to a deterministic rule. */
    semanticDrops: number;
    /** Characters the model still carries in capsules that replaced results. */
    capsuleChars: number;
    redactions: number;
    qualityInterventions: number;
    subagentChecks: number;
    subagentRevisions: number;
    /** Characters put back into context by re-runs of dropped output. */
    recoveryChars: number;
    dietP50: number;
    dietP95: number;
    /** Later calls that look like they re-ran a dropped result. */
    recoveryReruns: number;
    /** Reruns where nothing was written in between: the strongest recovery signal. */
    recoveryLikely: number;
    /** Reruns after some write, where routine work looks the same. */
    recoveryPossible: number;
    /** Reruns of a file that changed after the drop, so the re-read was required anyway. */
    recoveryInvalidated: number;
    /** Sum of the tool calls between those drops and their reruns. */
    recoveryCalls: number;
}
export interface UsageReport {
    windows: UsageWindow[];
    earliest: number | null;
    logLines: number;
    pricePerMillionInputTokens: number;
}
export declare const WINDOWS: readonly [{
    readonly label: "today";
    readonly days: 1;
}, {
    readonly label: "7 days";
    readonly days: 7;
}, {
    readonly label: "30 days";
    readonly days: 30;
}];
/** Local midnight, n days back. setDate rather than millisecond maths, so DST is handled. */
export declare function localMidnight(now: Date, daysBack: number): number;
export declare function summarizeUsage(input: UsageInput, jevReasons: readonly string[], specs?: readonly {
    label: string;
    days: number;
}[], pricePerMillionInputTokens?: number): UsageReport;
export interface RenderOptions {
    timeZone: string;
    now?: Date;
    stores?: string[];
}
/** A table of counts. Never prints tool output, prompts, commands, or any other content. */
export declare function renderUsage(report: UsageReport, options: RenderOptions): string;
export declare function readUsageInput(env: NodeJS.ProcessEnv, options?: {
    all?: boolean;
}): UsageInput;
