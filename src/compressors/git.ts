import { clip, type Extractor } from './types.js';

const STATUS_LINE = /^\s*(?:modified|deleted|new file|renamed|untracked):|^\s*(?:\?\?|M\s|A\s|D\s|R\s)|^On branch |^\d+ files? changed|^\s*\d+ insertions?\(\+\)|^commit [0-9a-f]{7,}|^diff --git /;

export const gitOutput: Extractor = (input, budgets) => {
  const looksGit = /\bgit\b/.test(input.inputLine) || /^On branch |^commit [0-9a-f]{7,}|^diff --git /m.test(input.resultText);
  if (!looksGit) return null;
  const hits: string[] = [];
  for (const row of input.resultText.split('\n')) {
    if (!STATUS_LINE.test(row)) continue;
    hits.push(clip(row.trim(), 200));
    if (hits.length >= budgets.maxSummaryLines * 2) break;
  }
  if (hits.length === 0) return null;
  return {
    kind: 'git',
    lines: hits,
    retainedChars: hits.reduce((sum, line) => sum + line.length + 1, 0),
  };
};

