import type { CapsuleBudgets, CapsuleInput, ExtractedCapsule, Extractor } from './types.js';
/** Head plus signal lines, no tail: the note is the head of the record. */
export declare function sampleCapsule(input: CapsuleInput, budgets: CapsuleBudgets, kind: string): ExtractedCapsule;
export declare const generic: Extractor;
