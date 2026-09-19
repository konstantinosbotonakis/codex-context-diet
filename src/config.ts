import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type PrivacyMode = 'strict' | 'standard' | 'off';

export interface ToolPolicy {
  /** `*`, an exact tool, `Bash:test`, `family:bash` or `output:test-log`. */
  match: string;
  minTokens?: number;
  keepThreshold?: number;
  dropThreshold?: number;
}

export interface DietConfig {
  enabled: boolean; mode: 'diet' | 'observe'; dryRun: boolean;
  /** 'cache' keeps a rolling per-session digest; 'off' is single-turn and writes nothing. */
  stateSource: 'cache' | 'off';
  minTokens: number; keepThreshold: number; dropThreshold: number; truncateHeadChars: number;
  maxStateTokens: number; stateResultCapChars: number; requestTimeoutMs: number;
  injectionGuard: boolean; model: string; neverDietTools: string[];
  promptGuard: boolean; promptGuardThreshold: number; promptGuardTimeoutMs: number;
  cacheMaxEntries: number; cacheMaxBytes: number; debug: boolean; apiKey?: string;
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
  /** How long after a drop an identical call still counts as a recovery. */
  recoveryWindowMs: number;
  /** Let approximate context pressure lower the size gate. It never raises it. */
  contextPressure: boolean;
  /** Pressure floors. 0 means keep the base minTokens for that stage. */
  pressureLowTokens: number;
  pressureModerateTokens: number;
  pressureHighTokens: number;
  pressureCriticalTokens: number;
  /** Per-tool overrides; the last matching entry wins. */
  toolPolicies: ToolPolicy[];
  /** Write a snapshot on PreCompact and inject it once after a compaction. */
  compactionResurrection: boolean;
  /** Character cap for that snapshot. */
  snapshotMaxChars: number;
  /** Judge whether a subagent result is ready for the parent agent. */
  subagentGuard: boolean;
  subagentGuardThreshold: number;
  subagentGuardMaxInterventions: number;
}

/** Published Jev 1.13 input price. Output tokens are free, so this is the whole cost. */
export const JEV_INPUT_PRICE_PER_MTOK = 0.042;

export const DEFAULT_CONFIG: DietConfig = {
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
  subagentGuard: true,
  subagentGuardThreshold: 0.8,
  subagentGuardMaxInterventions: 1,
};

/** PLUGIN_DATA when the host provides it, otherwise a stable per-user directory. */
export function pluginDataDir(env: NodeJS.ProcessEnv): string {
  return env.PLUGIN_DATA ?? env.CLAUDE_PLUGIN_DATA ?? join(env.HOME ?? '.', '.codex-context-diet');
}

export function configPath(env: NodeJS.ProcessEnv): string {
  return join(pluginDataDir(env), 'config.json');
}

function num(raw: unknown, fallback: number, min = 0): number {
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= min ? raw : fallback;
}

function bool(raw: unknown, fallback: boolean): boolean {
  return typeof raw === 'boolean' ? raw : fallback;
}

function str(raw: unknown, fallback: string): string {
  return typeof raw === 'string' && raw.length > 0 ? raw : fallback;
}

function strArray(raw: unknown, fallback: string[]): string[] {
  if (!Array.isArray(raw)) return [...fallback];
  return raw.filter((value): value is string => typeof value === 'string' && value.length > 0);
}

function privacyMode(raw: unknown, fallback: PrivacyMode): PrivacyMode {
  return raw === 'strict' || raw === 'standard' || raw === 'off' ? raw : fallback;
}

function toolPolicies(raw: unknown): ToolPolicy[] {
  if (!Array.isArray(raw)) return [];
  const out: ToolPolicy[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    if (typeof record.match !== 'string' || record.match.trim().length === 0) continue;
    const policy: ToolPolicy = { match: record.match };
    for (const key of ['minTokens', 'keepThreshold', 'dropThreshold'] as const) {
      const value = record[key];
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) policy[key] = value;
    }
    out.push(policy);
  }
  return out;
}

/** Total: never throws, and never returns a field of the wrong type. */
export function resolveConfig(raw: unknown): DietConfig {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const config: DietConfig = {
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
      ? o.neverDietTools.filter((tool): tool is string => typeof tool === 'string')
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
    subagentGuard: bool(o.subagentGuard, DEFAULT_CONFIG.subagentGuard),
    subagentGuardThreshold: num(o.subagentGuardThreshold, DEFAULT_CONFIG.subagentGuardThreshold),
    subagentGuardMaxInterventions: Math.floor(
      num(o.subagentGuardMaxInterventions, DEFAULT_CONFIG.subagentGuardMaxInterventions),
    ),
  };
  if (typeof o.apiKey === 'string' && o.apiKey.length > 0) config.apiKey = o.apiKey;
  return config;
}

export function loadConfig(env: NodeJS.ProcessEnv): DietConfig {
  try {
    return resolveConfig(JSON.parse(readFileSync(configPath(env), 'utf8')));
  } catch {
    return DEFAULT_CONFIG;
  }
}
