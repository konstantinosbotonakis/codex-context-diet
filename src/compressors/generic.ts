import { sampleResult } from '../sample.js';
import type { CapsuleBudgets, CapsuleInput, ExtractedCapsule, Extractor } from './types.js';

/** Head plus signal lines, no tail: the note is the head of the record. */
export function sampleCapsule(input: CapsuleInput, budgets: CapsuleBudgets, kind: string): ExtractedCapsule {
  const sample = sampleResult(input.resultText, {
    budgetChars: Math.max(600, budgets.headChars + 900),
    headChars: budgets.headChars,
    tailChars: 0,
  });
  return {
    kind,
    lines: [sample.text],
    retainedChars: Math.max(0, input.resultText.length - sample.omitted),
  };
}

export const generic: Extractor = (input, budgets) => sampleCapsule(input, budgets, 'generic');

