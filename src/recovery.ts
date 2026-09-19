import type { CacheEntry, TouchRecord } from './cache.js';
import { fingerprint, normalizeText, resourceOf } from './dedupe.js';

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

export type RecoveryClass = 'likely_recovery' | 'possible_rerun' | 'invalidated_rerun';

export interface RecoveryClassification {
  classification: RecoveryClass;
  because: string;
}

/**
 * How much weight a matched rerun deserves.
 *
 * The match itself only says the same call ran again. What happened in
 * between decides whether that reads as a lost result or as ordinary work:
 * a file that changed had to be read again whatever the diet did, and any
 * write in between makes a routine rerun indistinguishable from a recovery.
 */
export function classifyRecovery(
  entry: CacheEntry,
  current: { toolName: string; inputLine: string },
  touches: readonly TouchRecord[],
): RecoveryClassification {
  const at = Date.parse(entry.at);
  const after = touches.filter((touch) => {
    const touchedAt = Date.parse(touch.at);
    return Number.isFinite(touchedAt) && (!Number.isFinite(at) || touchedAt > at);
  });
  const resource = resourceOf(current.toolName, current.inputLine);
  if (resource !== null && after.some((touch) => touch.paths.includes('*') || touch.paths.includes(resource))) {
    return {
      classification: 'invalidated_rerun',
      because: 'the file changed after the drop, so reading it again was required anyway',
    };
  }
  if (after.length > 0) {
    return {
      classification: 'possible_rerun',
      because: 'something was written after the drop, so a routine rerun looks the same',
    };
  }
  return {
    classification: 'likely_recovery',
    because: 'nothing was written between the drop and the rerun',
  };
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
