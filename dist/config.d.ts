export interface DietConfig {
    enabled: boolean;
    mode: 'diet' | 'observe';
    dryRun: boolean;
    /** 'cache' keeps a rolling per-session digest; 'off' is single-turn and writes nothing. */
    stateSource: 'cache' | 'off';
    minTokens: number;
    keepThreshold: number;
    dropThreshold: number;
    truncateHeadChars: number;
    maxStateTokens: number;
    stateResultCapChars: number;
    requestTimeoutMs: number;
    injectionGuard: boolean;
    model: string;
    neverDietTools: string[];
    promptGuard: boolean;
    promptGuardThreshold: number;
    promptGuardTimeoutMs: number;
    cacheMaxEntries: number;
    cacheMaxBytes: number;
    debug: boolean;
    apiKey?: string;
    /** Days of event log to keep. 0 keeps everything. */
    logRetentionDays: number;
}
export declare const DEFAULT_CONFIG: DietConfig;
/** PLUGIN_DATA when the host provides it, otherwise a stable per-user directory. */
export declare function pluginDataDir(env: NodeJS.ProcessEnv): string;
export declare function configPath(env: NodeJS.ProcessEnv): string;
/** Total: never throws, and never returns a field of the wrong type. */
export declare function resolveConfig(raw: unknown): DietConfig;
export declare function loadConfig(env: NodeJS.ProcessEnv): DietConfig;
