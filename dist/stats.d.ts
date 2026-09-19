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
