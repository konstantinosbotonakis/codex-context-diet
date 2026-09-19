import type { CacheEntry } from './cache.js';
import { fingerprint, normalizeText } from './dedupe.js';

/**
 * Recovery inference: a later call with the same tool and the same normalised
 * input, soon after a dropped result, most likely re-ran the tool because the
 * dropped contents were needed. The inference is deliberately loose and is
 * documented as an estimate: an intentional rerun looks the same from here.
 */
export interface RecoveryMatch {
  entry: CacheEntry;
  afterMs: number;
  /** How many cached calls landed between the drop and this call. */
  afterCalls: number;
}

/** Stable key for one tool plus one input, so a recovery scores once per input. */
export function inputKey(toolName: string, inputLine: string): string {
  return fingerprint(toolName, inputLine, '');
}

export function detectRecovery(
  cache: CacheEntry[],
  alreadySeen: readonly string[],
  current: { toolName: string; inputLine: string },
  now: number,
  windowMs: number,
): RecoveryMatch | null {
  const input = normalizeText(current.inputLine);
  if (alreadySeen.includes(inputKey(current.toolName, current.inputLine))) return null;
  for (let index = cache.length - 1; index >= 0; index -= 1) {
    const entry = cache[index] as CacheEntry;
    if (entry.decision !== 'drop_result') continue;
    if (entry.tool_name !== current.toolName) continue;
    if (normalizeText(entry.input) !== input) continue;
    const at = Date.parse(entry.at);
    if (!Number.isFinite(at)) continue;
    const afterMs = now - at;
    if (afterMs < 0 || afterMs > windowMs) continue;
    return { entry, afterMs, afterCalls: cache.length - index };
  }
  return null;
}
