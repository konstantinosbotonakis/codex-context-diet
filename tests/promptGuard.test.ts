import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, configPath } from '../src/config.js';
import {
  decidePromptRisk,
  Q_IRREVERSIBLE,
  Q_TOUCHES_PRODUCTION,
  riskQuestions,
  warnLine,
} from '../src/codex/promptGuard.js';
import { main as sessionMain, readGoal } from '../src/codex/session.js';

const config = { ...DEFAULT_CONFIG, promptGuard: true };
const tempEnv = (): NodeJS.ProcessEnv =>
  ({ PLUGIN_DATA: mkdtempSync(join(tmpdir(), 'cd-guard-')) } as NodeJS.ProcessEnv);
const payload = (prompt: string): string =>
  JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt, cwd: '/tmp' });
const answers = (over: Record<string, number>): string =>
  JSON.stringify({ [Q_TOUCHES_PRODUCTION]: 0, [Q_IRREVERSIBLE]: 0, ...over });

describe('prompt risk', () => {
  it('asks two literal questions with both boundary cases spelled out', () => {
    const questions = riskQuestions();
    expect(Object.keys(questions)).toEqual([Q_TOUCHES_PRODUCTION, Q_IRREVERSIBLE]);
    for (const question of Object.values(questions)) {
      expect(question.type).toBe('noul');
      expect(question.criteria?.true).toBeTruthy();
      expect(question.criteria?.false).toBeTruthy();
    }
  });

  it('flags at or above the threshold, and stays quiet below it', () => {
    const high = decidePromptRisk(
      { [Q_TOUCHES_PRODUCTION]: { noul: 0.9 }, [Q_IRREVERSIBLE]: { noul: 0.2 } },
      config,
    );
    expect(high.hazards.map((hazard) => hazard.id)).toEqual([Q_TOUCHES_PRODUCTION]);
    expect(high.line).toContain('touches_production 0.90');

    const boundary = decidePromptRisk(
      { [Q_TOUCHES_PRODUCTION]: { noul: 0.7 }, [Q_IRREVERSIBLE]: { noul: 0 } },
      config,
    );
    expect(boundary.hazards).toHaveLength(1);

    const below = decidePromptRisk(
      { [Q_TOUCHES_PRODUCTION]: { noul: 0.69 }, [Q_IRREVERSIBLE]: { noul: 0.1 } },
      config,
    );
    expect(below).toEqual({ hazards: [], line: null });
  });

  it('names every hazard that fired', () => {
    const both = decidePromptRisk(
      { [Q_TOUCHES_PRODUCTION]: { noul: 0.8 }, [Q_IRREVERSIBLE]: { noul: 0.95 } },
      config,
    );
    expect(both.line).toBe(warnLine(both.hazards));
    expect(both.line).toContain('touches_production 0.80');
    expect(both.line).toContain('irreversible 0.95');
  });

  it('ignores malformed answers instead of throwing', () => {
    expect(decidePromptRisk({}, config)).toEqual({ hazards: [], line: null });
    expect(decidePromptRisk({ [Q_TOUCHES_PRODUCTION]: { noul: Number.NaN } }, config).line).toBeNull();
  });
});

describe('session guard', () => {
  it('stays silent when the flag is off, even with a hazard ready', async () => {
    const env = { ...tempEnv(), CONTEXT_DIET_TEST_ANSWERS: answers({ [Q_TOUCHES_PRODUCTION]: 0.95 }) };
    expect(await sessionMain(payload('deploy it to production'), env)).toBe('');
  });

  it('adds one line of context when the flag is on and a hazard fires', async () => {
    const env = { ...tempEnv(), CONTEXT_DIET_TEST_ANSWERS: answers({ [Q_TOUCHES_PRODUCTION]: 0.95 }) };
    writeFileSync(configPath(env), JSON.stringify({ promptGuard: true }));
    const parsed = JSON.parse(await sessionMain(payload('deploy it to production'), env)) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(['hookSpecificOutput']);
    const hook = parsed.hookSpecificOutput as Record<string, unknown>;
    expect(hook.hookEventName).toBe('UserPromptSubmit');
    expect(String(hook.additionalContext)).toContain('live system');
  });

  it('says nothing when the flag is on and nothing fires', async () => {
    const env = { ...tempEnv(), CONTEXT_DIET_TEST_ANSWERS: answers({ [Q_TOUCHES_PRODUCTION]: 0.1 }) };
    writeFileSync(configPath(env), JSON.stringify({ promptGuard: true }));
    expect(await sessionMain(payload('fix the typo in the README'), env)).toBe('');
  });

  it('still records the goal when the guard fires', async () => {
    const env = { ...tempEnv(), CONTEXT_DIET_TEST_ANSWERS: answers({ [Q_TOUCHES_PRODUCTION]: 0.9 }) };
    writeFileSync(configPath(env), JSON.stringify({ promptGuard: true }));
    await sessionMain(payload('purge the production cache'), env);
    expect(readGoal(env, 's1').goal).toBe('purge the production cache');
  });

  it('never blocks the prompt when there is no asker', async () => {
    const env = tempEnv();
    writeFileSync(configPath(env), JSON.stringify({ promptGuard: true }));
    expect(await sessionMain(payload('drop the production table'), env)).toBe('');
    expect(readGoal(env, 's1').goal).toBe('drop the production table');
  });
});
