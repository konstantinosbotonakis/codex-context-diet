import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface DietConfig {
  enabled: boolean; mode: 'diet' | 'observe'; dryRun: boolean;
  /** 'cache' keeps a rolling per-session digest; 'off' is single-turn and writes nothing. */
  stateSource: 'cache' | 'off';
  minTokens: number; keepThreshold: number; dropThreshold: number; truncateHeadChars: number;
  maxStateTokens: number; stateResultCapChars: number; requestTimeoutMs: number;
  injectionGuard: boolean; model: string; neverDietTools: string[];
  cacheMaxEntries: number; cacheMaxBytes: number; debug: boolean; apiKey?: string;
}

export const DEFAULT_CONFIG: DietConfig = {
  enabled: true, mode: 'diet', dryRun: false, stateSource: 'cache',
  minTokens: 2000, keepThreshold: 0.5, dropThreshold: 0.25, truncateHeadChars: 300,
  maxStateTokens: 25000, stateResultCapChars: 4000, requestTimeoutMs: 2500,
  injectionGuard: true, model: 'jev-latest', neverDietTools: [],
  cacheMaxEntries: 40, cacheMaxBytes: 262144, debug: false,
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
    model: str(o.model, DEFAULT_CONFIG.model),
    neverDietTools: Array.isArray(o.neverDietTools)
      ? o.neverDietTools.filter((tool): tool is string => typeof tool === 'string')
      : [],
    cacheMaxEntries: Math.floor(num(o.cacheMaxEntries, DEFAULT_CONFIG.cacheMaxEntries, 1)),
    cacheMaxBytes: Math.floor(num(o.cacheMaxBytes, DEFAULT_CONFIG.cacheMaxBytes, 1)),
    debug: bool(o.debug, DEFAULT_CONFIG.debug),
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
