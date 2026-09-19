import type { CacheEntry } from './cache.js';

/**
 * Approximate context pressure, owned by the plugin.
 *
 * Codex hook payloads carry no token or context usage, and the transcript
 * format is not a stable interface, so this is a conservative estimate of what
 * the session is carrying: every cached result counts whatever the model
 * actually kept for it, characters over four as tokens. It is a floor, not a
 * measurement, and it only ever lowers the size gate.
 */
export type PressureStage = 'low' | 'moderate' | 'high' | 'critical';

/** Retained-token marks for the stages. Fractions of a large context, not measurements. */
export const PRESSURE_THRESHOLDS = { moderate: 40_000, high: 90_000, critical: 150_000 } as const;

export function pressureStage(retained: number): PressureStage {
  if (retained >= PRESSURE_THRESHOLDS.critical) return 'critical';
  if (retained >= PRESSURE_THRESHOLDS.high) return 'high';
  if (retained >= PRESSURE_THRESHOLDS.moderate) return 'moderate';
  return 'low';
}

/** Characters the session is estimated to still be carrying. */
export function retainedChars(cache: CacheEntry[]): number {
  let chars = 0;
  for (const entry of cache) {
    const kept =
      typeof entry.keptChars === 'number' && Number.isFinite(entry.keptChars)
        ? entry.keptChars
        : entry.chars;
    chars += Math.max(0, kept);
  }
  return chars;
}

export function retainedTokens(cache: CacheEntry[]): number {
  return Math.round(retainedChars(cache) / 4);
}

