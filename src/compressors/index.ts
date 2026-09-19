import { buildLog } from './buildLog.js';
import { fileRead } from './fileRead.js';
import { generic } from './generic.js';
import { gitOutput } from './git.js';
import { jsonShape } from './json.js';
import { mcpOutput } from './mcp.js';
import { stackTrace } from './stackTrace.js';
import { testLog } from './testLog.js';
import { clip, type CapsuleBudgets, type CapsuleInput, type ExtractedCapsule, type Extractor } from './types.js';

/** First extractor that recognises the output wins. Generic always matches. */
const EXTRACTORS: readonly Extractor[] = [
  testLog,
  stackTrace,
  buildLog,
  jsonShape,
  gitOutput,
  fileRead,
  mcpOutput,
];

export interface Capsule {
  kind: string;
  text: string;
  omittedChars: number;
}

export function extractEvidence(input: CapsuleInput, budgets: CapsuleBudgets): ExtractedCapsule {
  for (const extractor of EXTRACTORS) {
    const found = extractor(input, budgets);
    if (found !== null) return found;
  }
  return generic(input, budgets) as ExtractedCapsule;
}

/**
 * The note that replaces a dropped result. Structured evidence first, bounded
 * by maxChars, with the omission count stated at the end.
 */
export function renderCapsule(input: CapsuleInput, budgets: CapsuleBudgets, extras: string[] = []): Capsule {
  const found = extractEvidence(input, budgets);
  const header = '[codex-context-diet evidence]\nCommand: ' + clip((input.toolName + ' ' + input.inputLine).trim(), 200);
  const facts = (found.facts ?? []).map((fact) => clip(fact, 200)).join('\n');
  // Deterministic evidence first, then the selected chunks. When the budget
  // runs out the loop drops from the end, so chunks give way before evidence.
  const body = [
    ...found.lines.map((line) => clip(line, 400)),
    ...extras.map((line) => clip(line, 2000)),
  ].filter((line) => line.trim().length > 0);
  const omitted = Math.max(0, input.resultText.length - found.retainedChars);
  const tail = omitted.toLocaleString('en-US') + ' chars omitted.';
  const render = (): string =>
    [header, facts, body.join('\n'), tail].filter((section) => section.length > 0).join('\n\n');
  let text = render();
  while (text.length > budgets.maxChars && body.length > 0) {
    body.pop();
    text = render();
  }
  if (text.length > budgets.maxChars) text = text.slice(0, budgets.maxChars);
  return { kind: found.kind, text, omittedChars: omitted };
}
