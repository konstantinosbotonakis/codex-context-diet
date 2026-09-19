import { clip, type Extractor } from './types.js';

const READ_TOOLS = /^(?:read|read_file|readfile|view|view_file)$/i;
const PATHY = /^[^\s]*[/.][^\s]*$/;

/** A file read is best represented by its opening lines, which set the context. */
export const fileRead: Extractor = (input, budgets) => {
  if (!READ_TOOLS.test(input.toolName) && !PATHY.test(input.inputLine.trim())) return null;
  const rows = input.resultText.split('\n').slice(0, Math.max(4, budgets.maxSummaryLines * 2));
  if (rows.length === 0) return null;
  const shown = rows.map((row) => clip(row, 200));
  return {
    kind: 'file-read',
    facts: ['first ' + shown.length + ' line(s)'],
    lines: shown,
    retainedChars: shown.reduce((sum, line) => sum + line.length + 1, 0),
  };
};

