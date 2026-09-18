import { appendFileSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pluginDataDir, type DietConfig } from './config.js';

export interface CacheEntry {
  tool_use_id: string; tool_name: string; at: string; input: string;
  head: string; tail: string; chars: number; decision: string; goal_index: number;
}

const UNSAFE = /[^A-Za-z0-9._-]+/g;

/** Session ids come from the host, so a hostile one must not escape the data directory. */
export function sessionKey(sessionId: string): string {
  const cleaned = sessionId.replace(UNSAFE, '_').slice(0, 128);
  return cleaned.length > 0 ? cleaned : 'unknown';
}

export function sessionsDir(env: NodeJS.ProcessEnv): string {
  return join(pluginDataDir(env), 'sessions');
}

export function cachePath(env: NodeJS.ProcessEnv, sessionId: string): string {
  return join(sessionsDir(env), sessionKey(sessionId) + '.results.jsonl');
}

function isEntry(value: unknown): value is CacheEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.tool_use_id === 'string' && typeof entry.chars === 'number' && Number.isFinite(entry.chars);
}

/** Newest first in the file, oldest first here. A corrupt line costs one entry, never the run. */
export function readCache(env: NodeJS.ProcessEnv, sessionId: string, config?: DietConfig): CacheEntry[] {
  try {
    const entries: CacheEntry[] = [];
    for (const line of readFileSync(cachePath(env, sessionId), 'utf8').split('\n')) {
      if (line.trim().length === 0) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (isEntry(parsed)) entries.push(parsed);
      } catch {
        // skip
      }
    }
    const cap = config?.cacheMaxEntries ?? 0;
    return cap > 0 ? entries.slice(-cap) : entries;
  } catch {
    return [];
  }
}

export function appendCache(
  env: NodeJS.ProcessEnv,
  sessionId: string,
  entry: CacheEntry,
  config: DietConfig,
): void {
  try {
    mkdirSync(sessionsDir(env), { recursive: true });
  } catch {
    return;
  }
  const path = cachePath(env, sessionId);
  try {
    appendFileSync(path, JSON.stringify(entry) + '\n');
  } catch {
    return;
  }
  try {
    if (statSync(path).size <= config.cacheMaxBytes) return;
    const kept: CacheEntry[] = [];
    let bytes = 0;
    const budget = Math.floor(config.cacheMaxBytes / 2);
    for (const candidate of readCache(env, sessionId).slice(-config.cacheMaxEntries).reverse()) {
      const size = JSON.stringify(candidate).length + 1;
      if (bytes + size > budget) break;
      bytes += size;
      kept.unshift(candidate);
    }
    const tmp = path + '.' + process.pid + '.tmp';
    writeFileSync(tmp, kept.map((line) => JSON.stringify(line)).join('\n') + '\n');
    renameSync(tmp, path);
  } catch {
    // Compaction is best effort: a lost entry costs history, never correctness.
  }
}

export function countSessions(env: NodeJS.ProcessEnv): number {
  try {
    return readdirSync(sessionsDir(env)).filter((name) => name.endsWith('.results.jsonl')).length;
  } catch {
    return 0;
  }
}
