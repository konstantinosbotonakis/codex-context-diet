import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { expandFixture, loadCases, readFixture, renderEvalReport, runEvaluation } from '../src/eval.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('prompt guard evaluation set', () => {
  it('has enough labelled prompts on both sides', () => {
    const fixture = JSON.parse(readFileSync(join(root, 'examples', 'eval-prompts.json'), 'utf8')) as {
      prompts: { prompt: string; expect: string }[];
    };
    expect(fixture.prompts.length).toBeGreaterThanOrEqual(10);
    expect(fixture.prompts.filter((entry) => entry.expect === 'flag').length).toBeGreaterThanOrEqual(4);
    expect(fixture.prompts.filter((entry) => entry.expect === 'quiet').length).toBeGreaterThanOrEqual(4);
    for (const entry of fixture.prompts) {
      expect(['flag', 'quiet']).toContain(entry.expect);
      expect(entry.prompt.trim().length).toBeGreaterThan(0);
    }
  });

  it('runs offline without a key', () => {
    const fixture = JSON.parse(readFileSync(join(root, 'examples', 'eval-prompts.json'), 'utf8')) as {
      prompts: unknown[];
    };
    const out = execFileSync('node', [join(root, 'scripts', 'eval-prompts.mjs')], { encoding: 'utf8' });
    expect(out).toContain('Context Diet prompt-guard evaluation');
    expect(out).toContain('run with --live');
    expect(out).toContain('prompts: ' + fixture.prompts.length);
  });
});

const REQUIRED_CATEGORIES = [
  'head-error', 'middle-error', 'tail-error',
  'huge-successful-build', 'huge-failed-build', 'one-failed-among-thousands',
  'generated-source', 'large-json-response', 'repeated-identical-json',
  'timestamp-output', 'uuid-generation', 'random-token-generation', 'changing-network-result',
  'file-read-before-modification', 'file-read-after-modification', 'same-command-before-after',
  'prompt-injection', 'fake-assistant-instructions', 'api-keys-in-output', 'private-key-block',
  'looks-reproducible-not', 'looks-unique-already-exists', 'malformed-mcp-payload',
  'enormous-stack-trace', 'huge-successful-test-output', 'summary-only-at-tail',
];

describe('decision evaluation corpus', () => {
  it('covers the required difficult categories with both actions', () => {
    const cases = loadCases();
    expect(cases.length).toBeGreaterThanOrEqual(26);
    expect(new Set(cases.map((item) => item.id)).size).toBe(cases.length);
    const categories = cases.map((item) => item.category);
    for (const category of REQUIRED_CATEGORIES) expect(categories).toContain(category);
    expect(cases.filter((item) => item.expectedAction === 'keep').length).toBeGreaterThanOrEqual(12);
    expect(cases.filter((item) => item.expectedAction === 'drop').length).toBeGreaterThanOrEqual(6);
    for (const item of cases) {
      expect(readFixture(item.fixture).length).toBeGreaterThan(200);
      for (const key of ['needs_contents', 'replaceable', 'keep_call']) {
        expect(typeof item.signals[key]).toBe('number');
      }
    }
  });

  it('expands filler markers deterministically', () => {
    expect(expandFixture('a\n{{FILL:3}}\nb').split('\n')).toHaveLength(5);
    expect(expandFixture('{{FILL:2}}').split('\n')[0]).toBe('info: routine output line 1');
  });

  it('decides every case correctly offline, with no false drops', async () => {
    const report = await runEvaluation({});
    expect(report.mode).toBe('offline');
    expect(report.metrics.falseDrops).toBe(0);
    expect(report.metrics.correct).toBe(report.metrics.cases);
    expect(report.metrics.replacementRate).toBeGreaterThan(0);
    expect(report.metrics.p95Ms).toBeGreaterThan(0);
    expect(renderEvalReport(report)).toContain('false drops:      0');
  });
});

