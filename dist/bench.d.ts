export interface Stat {
    p50: number;
    p95: number;
    mean: number;
}
export interface BenchReport {
    iterations: number;
    resultChars: number;
    local: Stat;
    commandHook: Stat;
    mcp: Stat;
    mcpStartupMs: number;
    liveMs: number | null;
    liveNote: string;
}
export interface BenchOptions {
    iterations?: number;
    live?: boolean;
}
export declare function runBenchmark(options?: BenchOptions): Promise<BenchReport>;
export declare function renderBenchmark(report: BenchReport): string;
