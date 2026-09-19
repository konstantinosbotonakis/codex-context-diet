import type { CacheEntry, TouchRecord } from './cache.js';
/** Shared reason string: stats counts it and the note names it. */
export declare const DUPLICATE_REASON = "deterministic_duplicate_drop";
/** Trailing spaces, ANSI colour and blank-line runs do not change what a result means. */
export declare function normalizeText(text: string): string;
export declare function fingerprint(toolName: string, inputLine: string, resultText: string): string;
/** The file a read-class result came from, when one can be named. */
export declare function resourceOf(toolName: string, inputLine: string): string | null;
/**
 * Which paths a call may have written. Unknown write shapes return `*`, which
 * invalidates every later read duplicate rather than claiming reproducibility.
 */
export declare function touchedPaths(toolName: string, toolInput: unknown): string[];
/**
 * A duplicate is only real when the tool, the normalised input and the
 * normalised result all match, and nothing wrote to the resource afterwards.
 */
export declare function findDuplicate(toolName: string, inputLine: string, resultText: string, cache: CacheEntry[], touches: TouchRecord[]): CacheEntry | null;
