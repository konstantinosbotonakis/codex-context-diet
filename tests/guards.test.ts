import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { configPath, DEFAULT_CONFIG } from '../src/config.js';
import { decideQualityVerdict, handleStop } from '../src/codex/qualityGuard.js';
import { decideSubagentVerdict, handleSubagent } from '../src/codex/subagent.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

interface GuardCase {
  id: string;
  expected: string;
  reason?: string;
  signals?: Record<string, number>;
  loopProtection?: boolean;
}

const load = (file: string): { cases: GuardCase[] } =>
  JSON.parse(readFileSync(join(root, 'evals', 'guards', file), 'utf8')) as { cases: GuardCase[] };

const tempEnv = (config: Record<string, unknown>): NodeJS.ProcessEnv => {
  const dir = mkdtempSync(join(tmpdir(), 'cd-guards-'));
  const env = { ...process.env, PLUGIN_DATA: dir } as NodeJS.ProcessEnv;
  writeFileSync(configPath(env), JSON.stringify(config));
  return env;
};

describe('subagent guard corpus', () => {
  const corpus = load('subagent-cases.json');

  it('covers the labelled scenarios', () => {
    expect(corpus.cases.map((item) => item.id)).toEqual(expect.arrayContaining([
      'concise-complete', 'incomplete-result', 'unsupported-conclusion', 'evidence-missing',
      'raw-log-dump', 'lengthy-necessary-evidence', 'already-continued', 'revision-limit-reached',
    ]));
  });

  for (const item of corpus.cases.filter((entry) => !entry.loopProtection)) {
    it(item.id + ' resolves to ' + item.expected, () => {
      expect(decideSubagentVerdict(item.signals ?? {}, DEFAULT_CONFIG).action).toBe(item.expected);
    });
  }

  it('lets a subagent through when Codex already continued it', async () => {
    const env = tempEnv({ subagentGuard: true });
    env.CONTEXT_DIET_TEST_ANSWERS = JSON.stringify({ '*': 0 });
    const output = await handleSubagent(
      { hook_event_name: 'SubagentStop', agent_id: 'a1', last_assistant_message: 'x'.repeat(600), stop_hook_active: true },
      env,
    );
    expect(output).toBe('');
  });

  it('stops asking after the revision cap', async () => {
    const env = tempEnv({ subagentGuard: true, subagentGuardMaxInterventions: 1 });
    env.CONTEXT_DIET_TEST_ANSWERS = JSON.stringify({ '*': 0 });
    const payload = {
      hook_event_name: 'SubagentStop', agent_id: 'a1', last_assistant_message: 'y'.repeat(600), stop_hook_active: false,
    };
    expect(await handleSubagent(payload, env)).toContain('decision');
    expect(await handleSubagent(payload, env)).toBe('');
  });
});

describe('quality guard corpus', () => {
  const corpus = load('quality-cases.json');

  it('covers the labelled scenarios', () => {
    expect(corpus.cases.map((item) => item.id)).toEqual(expect.arrayContaining([
      'complete-with-tests', 'missing-verification', 'known-failing-test', 'unsupported-claim',
      'question-only', 'documentation-only', 'trivial-edit', 'blocked-externally',
    ]));
  });

  for (const item of corpus.cases) {
    it(item.id + ' resolves to ' + item.expected, () => {
      expect(decideQualityVerdict(item.signals ?? {}, DEFAULT_CONFIG).action).toBe(item.expected);
    });
  }

  it('stays off unless it is enabled', async () => {
    const env = tempEnv({ qualityGuard: false });
    env.CONTEXT_DIET_TEST_ANSWERS = JSON.stringify({ '*': 0 });
    const output = await handleStop(
      { hook_event_name: 'Stop', turn_id: 'turn1', last_assistant_message: 'z'.repeat(600), stop_hook_active: false },
      env,
    );
    expect(output).toBe('');
  });
});

