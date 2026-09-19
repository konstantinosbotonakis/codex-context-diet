export type PrivacyMode = 'strict' | 'standard' | 'off';
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
    /** USD per million input tokens, used by the cost line in stats. */
    pricePerMillionInputTokens: number;
    /** strict redacts and honours path exclusions, standard only redacts, off does neither. */
    privacyMode: PrivacyMode;
    /** Path globs that must never reach Jev or the cache. Strict mode only. */
    neverSendPaths: string[];
    /** Tools whose results must never leave the machine. */
    neverSendTools: string[];
    /** Character cap for the evidence capsule that replaces a dropped result. */
    capsuleMaxChars: number;
    capsuleMaxErrorLines: number;
    capsuleMaxStackFrames: number;
    capsuleMaxSummaryLines: number;
    /** Drop a result that is byte-identical to one the session already has. */
    dedupe: boolean;
    /** Ask Jev which chunks of an exceptionally large result to keep in the capsule. */
    chunkRelevance: boolean;
    chunkMinChars: number;
    chunkMaxChars: number;
    chunkMaxChunks: number;
    chunkMaxInclude: number;
}
/** Published Jev 1.13 input price. Output tokens are free, so this is the whole cost. */
export declare const JEV_INPUT_PRICE_PER_MTOK = 0.042;
export declare const DEFAULT_CONFIG: DietConfig;
/** PLUGIN_DATA when the host provides it, otherwise a stable per-user directory. */
export declare function pluginDataDir(env: NodeJS.ProcessEnv): string;
export declare function configPath(env: NodeJS.ProcessEnv): string;
/** Total: never throws, and never returns a field of the wrong type. */
export declare function resolveConfig(raw: unknown): DietConfig;
export declare function loadConfig(env: NodeJS.ProcessEnv): DietConfig;
