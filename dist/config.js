import { readFileSync } from 'node:fs';
import { join } from 'node:path';
/** Published Jev 1.13 input price. Output tokens are free, so this is the whole cost. */
export const JEV_INPUT_PRICE_PER_MTOK = 0.042;
export const DEFAULT_CONFIG = {
    enabled: true, mode: 'diet', dryRun: false, stateSource: 'cache',
    minTokens: 2000, keepThreshold: 0.5, dropThreshold: 0.25, truncateHeadChars: 300,
    maxStateTokens: 25000, stateResultCapChars: 4000, requestTimeoutMs: 5000,
    injectionGuard: true, model: 'jev-latest', neverDietTools: [],
    promptGuard: false, promptGuardThreshold: 0.7, promptGuardTimeoutMs: 3500,
    cacheMaxEntries: 40, cacheMaxBytes: 262144, debug: false,
    logRetentionDays: 30,
    pricePerMillionInputTokens: JEV_INPUT_PRICE_PER_MTOK,
    privacyMode: 'strict',
    neverSendPaths: ['**/.env', '**/.env.*', '**/*.pem', '**/*.key'],
    neverSendTools: [],
    capsuleMaxChars: 1200,
    capsuleMaxErrorLines: 20,
    capsuleMaxStackFrames: 10,
    capsuleMaxSummaryLines: 8,
    dedupe: true,
    chunkRelevance: true,
    chunkMinChars: 20_000,
    chunkMaxChars: 24_000,
    chunkMaxChunks: 12,
    chunkMaxInclude: 3,
    recoveryWindowMs: 600_000,
    contextPressure: true,
    pressureLowTokens: 0,
    pressureModerateTokens: 0,
    pressureHighTokens: 1000,
    pressureCriticalTokens: 750,
    toolPolicies: [],
    compactionResurrection: true,
    snapshotMaxChars: 1500,
};
/** PLUGIN_DATA when the host provides it, otherwise a stable per-user directory. */
export function pluginDataDir(env) {
    return env.PLUGIN_DATA ?? env.CLAUDE_PLUGIN_DATA ?? join(env.HOME ?? '.', '.codex-context-diet');
}
export function configPath(env) {
    return join(pluginDataDir(env), 'config.json');
}
function num(raw, fallback, min = 0) {
    return typeof raw === 'number' && Number.isFinite(raw) && raw >= min ? raw : fallback;
}
function bool(raw, fallback) {
    return typeof raw === 'boolean' ? raw : fallback;
}
function str(raw, fallback) {
    return typeof raw === 'string' && raw.length > 0 ? raw : fallback;
}
function strArray(raw, fallback) {
    if (!Array.isArray(raw))
        return [...fallback];
    return raw.filter((value) => typeof value === 'string' && value.length > 0);
}
function privacyMode(raw, fallback) {
    return raw === 'strict' || raw === 'standard' || raw === 'off' ? raw : fallback;
}
function toolPolicies(raw) {
    if (!Array.isArray(raw))
        return [];
    const out = [];
    for (const item of raw) {
        if (!item || typeof item !== 'object')
            continue;
        const record = item;
        if (typeof record.match !== 'string' || record.match.trim().length === 0)
            continue;
        const policy = { match: record.match };
        for (const key of ['minTokens', 'keepThreshold', 'dropThreshold']) {
            const value = record[key];
            if (typeof value === 'number' && Number.isFinite(value) && value >= 0)
                policy[key] = value;
        }
        out.push(policy);
    }
    return out;
}
/** Total: never throws, and never returns a field of the wrong type. */
export function resolveConfig(raw) {
    const o = (raw && typeof raw === 'object' ? raw : {});
    const config = {
        enabled: bool(o.enabled, DEFAULT_CONFIG.enabled),
        mode: o.mode === 'observe' ? 'observe' : 'diet',
        dryRun: bool(o.dryRun, DEFAULT_CONFIG.dryRun),
        stateSource: o.stateSource === 'off' ? 'off' : 'cache',
        minTokens: num(o.minTokens, DEFAULT_CONFIG.minTokens),
        keepThreshold: num(o.keepThreshold, DEFAULT_CONFIG.keepThreshold),
        dropThreshold: num(o.dropThreshold, DEFAULT_CONFIG.dropThreshold),
        truncateHeadChars: Math.floor(num(o.truncateHeadChars, DEFAULT_CONFIG.truncateHeadChars)),
        maxStateTokens: num(o.maxStateTokens, DEFAULT_CONFIG.maxStateTokens, 1),
        stateResultCapChars: Math.floor(num(o.stateResultCapChars, DEFAULT_CONFIG.stateResultCapChars, 1)),
        requestTimeoutMs: num(o.requestTimeoutMs, DEFAULT_CONFIG.requestTimeoutMs, 1),
        injectionGuard: bool(o.injectionGuard, DEFAULT_CONFIG.injectionGuard),
        promptGuard: bool(o.promptGuard, DEFAULT_CONFIG.promptGuard),
        promptGuardThreshold: num(o.promptGuardThreshold, DEFAULT_CONFIG.promptGuardThreshold),
        promptGuardTimeoutMs: num(o.promptGuardTimeoutMs, DEFAULT_CONFIG.promptGuardTimeoutMs, 1),
        model: str(o.model, DEFAULT_CONFIG.model),
        neverDietTools: Array.isArray(o.neverDietTools)
            ? o.neverDietTools.filter((tool) => typeof tool === 'string')
            : [],
        cacheMaxEntries: Math.floor(num(o.cacheMaxEntries, DEFAULT_CONFIG.cacheMaxEntries, 1)),
        cacheMaxBytes: Math.floor(num(o.cacheMaxBytes, DEFAULT_CONFIG.cacheMaxBytes, 1)),
        debug: bool(o.debug, DEFAULT_CONFIG.debug),
        logRetentionDays: num(o.logRetentionDays, DEFAULT_CONFIG.logRetentionDays),
        pricePerMillionInputTokens: num(o.pricePerMillionInputTokens, DEFAULT_CONFIG.pricePerMillionInputTokens),
        privacyMode: privacyMode(o.privacyMode, DEFAULT_CONFIG.privacyMode),
        neverSendPaths: strArray(o.neverSendPaths, DEFAULT_CONFIG.neverSendPaths),
        neverSendTools: strArray(o.neverSendTools, DEFAULT_CONFIG.neverSendTools),
        capsuleMaxChars: num(o.capsuleMaxChars, DEFAULT_CONFIG.capsuleMaxChars, 1),
        capsuleMaxErrorLines: num(o.capsuleMaxErrorLines, DEFAULT_CONFIG.capsuleMaxErrorLines),
        capsuleMaxStackFrames: num(o.capsuleMaxStackFrames, DEFAULT_CONFIG.capsuleMaxStackFrames),
        capsuleMaxSummaryLines: num(o.capsuleMaxSummaryLines, DEFAULT_CONFIG.capsuleMaxSummaryLines),
        dedupe: bool(o.dedupe, DEFAULT_CONFIG.dedupe),
        chunkRelevance: bool(o.chunkRelevance, DEFAULT_CONFIG.chunkRelevance),
        chunkMinChars: num(o.chunkMinChars, DEFAULT_CONFIG.chunkMinChars),
        chunkMaxChars: num(o.chunkMaxChars, DEFAULT_CONFIG.chunkMaxChars, 1),
        chunkMaxChunks: Math.floor(num(o.chunkMaxChunks, DEFAULT_CONFIG.chunkMaxChunks, 1)),
        chunkMaxInclude: Math.floor(num(o.chunkMaxInclude, DEFAULT_CONFIG.chunkMaxInclude)),
        recoveryWindowMs: num(o.recoveryWindowMs, DEFAULT_CONFIG.recoveryWindowMs),
        contextPressure: bool(o.contextPressure, DEFAULT_CONFIG.contextPressure),
        pressureLowTokens: num(o.pressureLowTokens, DEFAULT_CONFIG.pressureLowTokens),
        pressureModerateTokens: num(o.pressureModerateTokens, DEFAULT_CONFIG.pressureModerateTokens),
        pressureHighTokens: num(o.pressureHighTokens, DEFAULT_CONFIG.pressureHighTokens),
        pressureCriticalTokens: num(o.pressureCriticalTokens, DEFAULT_CONFIG.pressureCriticalTokens),
        toolPolicies: toolPolicies(o.toolPolicies),
        compactionResurrection: bool(o.compactionResurrection, DEFAULT_CONFIG.compactionResurrection),
        snapshotMaxChars: num(o.snapshotMaxChars, DEFAULT_CONFIG.snapshotMaxChars, 1),
    };
    if (typeof o.apiKey === 'string' && o.apiKey.length > 0)
        config.apiKey = o.apiKey;
    return config;
}
export function loadConfig(env) {
    try {
        return resolveConfig(JSON.parse(readFileSync(configPath(env), 'utf8')));
    }
    catch {
        return DEFAULT_CONFIG;
    }
}
//# sourceMappingURL=config.js.map