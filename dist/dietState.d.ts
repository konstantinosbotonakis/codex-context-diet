import type { CacheEntry } from './cache.js';
export declare const DIET_CONTEXT: string;
export interface DietStateInput {
    goal: string;
    history: CacheEntry[];
    toolName: string;
    inputLine: string;
    resultText: string;
}
export interface DietState {
    context: string;
    goal: string;
    history: {
        i: number;
        text: string;
    }[];
    current: {
        call: string;
        result: string;
        resultChars: number;
    };
}
export interface FittedDietState {
    state: DietState;
    tokens: number;
    stage: string;
}
/**
 * The state sent to Jev: what already happened, plus the result being judged.
 * Shrinks in stages and throws when even the smallest form does not fit, which
 * the adapter treats as "keep the result unchanged".
 */
export declare function buildDietState(input: DietStateInput, opts: {
    maxStateTokens: number;
    resultCapChars: number;
}): FittedDietState;
