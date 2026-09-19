import { type CapsuleBudgets, type CapsuleInput, type ExtractedCapsule } from './types.js';
export interface Capsule {
    kind: string;
    text: string;
    omittedChars: number;
}
export declare function extractEvidence(input: CapsuleInput, budgets: CapsuleBudgets): ExtractedCapsule;
/**
 * The note that replaces a dropped result. Structured evidence first, bounded
 * by maxChars, with the omission count stated at the end.
 */
export declare function renderCapsule(input: CapsuleInput, budgets: CapsuleBudgets): Capsule;
