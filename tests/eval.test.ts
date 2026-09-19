import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

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
