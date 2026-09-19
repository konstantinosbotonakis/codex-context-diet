import { clip, type Extractor } from './types.js';

const SUMMARY = /\b\d+\s+(?:passed|failed|skipped|pending|todo)\b|\b(?:tests?|test suites?|suites?)\s*[:=]\s*\d+/i;
const FAIL_HEAD = /^\s*(?:FAIL|FAILED|not ok)\b|^\s*(?:✕|×|✗|●)\s/;
const DETAIL = /\b(?:assertionerror|expected|received|error|typeerror|referenceerror|rangeerror)\b/i;
const LOCATION = /(?:^|\s)(?:at\s+)?[^\s()]+\.\w{1,5}:\d+(?::\d+)?/;

/** Vitest, jest, pytest, go test and friends. The summary matters as much as the failures. */
export const testLog: Extractor = (input, budgets) => {
  const rows = input.resultText.split('\n');
  const summary = rows.filter((row) => SUMMARY.test(row)).slice(0, budgets.maxSummaryLines);
  const failures: string[] = [];
  for (let index = 0; index < rows.length && failures.length < budgets.maxErrorLines; index += 1) {
    const row = rows[index] ?? '';
    if (!FAIL_HEAD.test(row)) continue;
    failures.push(clip(row, 300));
    for (let next = index + 1; next < rows.length && failures.length < budgets.maxErrorLines; next += 1) {
      const detail = rows[next] ?? '';
      if (detail.trim().length === 0) break;
      if (!DETAIL.test(detail) && !LOCATION.test(detail)) break;
      failures.push(clip(detail, 300));
    }
  }
  if (summary.length === 0 && failures.length === 0) return null;
  return {
    kind: 'test-log',
    facts: summary.slice(0, 2),
    lines: failures,
    retainedChars: failures.reduce((sum, line) => sum + line.length + 1, 0),
  };
};

