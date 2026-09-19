import { describe, expect, it } from 'vitest';
import type { CacheEntry } from '../src/cache.js';
import { buildDietState } from '../src/dietState.js';
import { sampleResult } from '../src/sample.js';

const filler = (label: string, count: number): string =>
  Array.from({ length: count }, (_, index) => label + ' line ' + index + ' ordinary output ' + 'x'.repeat(40)).join('\n');

const bigLog = (): string => {
  const middle = [
    'FAIL tests/payment.test.ts',
    'AssertionError: expected 200, received 500',
    '  at tests/payment.test.ts:182:11',
    'ERROR in src/db/query.ts:44',
    'WARN deprecated config key payment.legacy',
  ].join('\n');
  const tail = ['Tests  482 passed | 1 failed (483)', 'exit code 1'].join('\n');
  return [filler('info', 400), middle, filler('processing', 1800), tail].join('\n');
};

const count = (text: string, needle: string): number => text.split(needle).length - 1;

const seed: CacheEntry = {
  tool_use_id: 'tool-0', tool_name: 'Read', at: '2026-09-19T00:00:00.000Z', input: 'src/a.ts',
  head: 'export const a = 1;', tail: '', chars: 20, decision: 'keep', goal_index: 0,
};

describe('signal sampling', () => {
  it('keeps a short result unchanged', () => {
    expect(sampleResult('small output', { budgetChars: 4000 })).toEqual({
      text: 'small output', signalLines: 0, omitted: 0,
    });
  });

  it('finds a failure that sits in the middle of a very large log', () => {
    const log = bigLog();
    expect(log.length).toBeGreaterThan(100_000);
    const sample = sampleResult(log, { budgetChars: 4000 });
    expect(sample.text.length).toBeLessThanOrEqual(4000);
    expect(sample.text).toContain('FAIL tests/payment.test.ts');
    expect(sample.text).toContain('AssertionError: expected 200, received 500');
    expect(sample.text).toContain('tests/payment.test.ts:182:11');
    expect(sample.text).toContain('src/db/query.ts:44');
    expect(sample.text).toContain('Tests  482 passed | 1 failed (483)');
    expect(sample.text).toContain('exit code 1');
    expect(sample.signalLines).toBeGreaterThanOrEqual(4);
    expect(sample.text).toContain('chars omitted');
    expect(sample.omitted).toBeGreaterThan(90_000);
  });

  it('caps pathological output instead of keeping every matching line', () => {
    // The head and the tail do not match, so every counted line comes from the
    // capped middle region.
    const log = [filler('info', 40), filler('error line', 5000), filler('done', 40)].join('\n');
    const sample = sampleResult(log, { budgetChars: 4000 });
    expect(sample.text.length).toBeLessThanOrEqual(4000);
    expect(count(sample.text, 'error line')).toBeLessThanOrEqual(20);
    expect(sample.signalLines).toBeLessThanOrEqual(20);
    expect(sample.signalLines).toBeGreaterThan(0);
  });

  it('still samples head and tail for a shape it does not know', () => {
    const lines = ['FIRST-MARKER-' + 'a'.repeat(30), ...Array.from({ length: 3000 }, () => 'z'.repeat(60)), 'LAST-MARKER-' + 'b'.repeat(30)];
    const sample = sampleResult(lines.join('\n'), { budgetChars: 2000 });
    expect(sample.text.length).toBeLessThanOrEqual(2000);
    expect(sample.text).toContain('FIRST-MARKER');
    expect(sample.text).toContain('LAST-MARKER');
  });

  it('carries the middle failure into the state sent to Jev', () => {
    const fitted = buildDietState(
      { goal: 'fix the failing test', history: [seed], toolName: 'Bash', inputLine: 'npm test', resultText: bigLog() },
      { maxStateTokens: 25_000, resultCapChars: 4000 },
    );
    const json = JSON.stringify(fitted.state);
    expect(fitted.stage).toBe('full');
    expect(json).toContain('AssertionError: expected 200, received 500');
    expect(json).toContain('tests/payment.test.ts:182:11');
    expect(fitted.state.current.result.length).toBeLessThanOrEqual(4000);
  });
});
