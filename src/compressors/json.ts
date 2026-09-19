import { clip, type Extractor } from './types.js';

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array of ' + value.length + ' item(s)';
  if (typeof value === 'object') return 'object with ' + Object.keys(value as object).length + ' key(s)';
  if (typeof value === 'string') return clip(JSON.stringify(value), 120);
  return String(value);
}

/** A JSON body is better judged by its shape than by its first page. */
export const jsonShape: Extractor = (input, budgets) => {
  const text = input.resultText.trim();
  if (!(text.startsWith('{') || text.startsWith('['))) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const facts = ['JSON ' + (Array.isArray(parsed) ? 'array of ' + parsed.length + ' item(s)' : 'object')];
  const lines: string[] = [];
  if (Array.isArray(parsed)) {
    if (parsed.length > 0) lines.push('first item: ' + clip(JSON.stringify(parsed[0]), 200));
  } else if (parsed !== null && typeof parsed === 'object') {
    for (const key of Object.keys(parsed as object).slice(0, budgets.maxSummaryLines * 2)) {
      lines.push(key + ': ' + describe((parsed as Record<string, unknown>)[key]));
    }
  }
  return {
    kind: 'json',
    facts,
    lines,
    retainedChars: lines.reduce((sum, line) => sum + line.length + 1, 0),
  };
};

