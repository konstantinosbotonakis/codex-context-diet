import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { configPath, DEFAULT_CONFIG } from '../src/config.js';
import { logPath } from '../src/codex/log.js';
import {
  handleSubagent,
  Q_ANSWER_ACTIONABLE,
  Q_EVIDENCE_PRESENT,
  Q_REDUNDANT_OUTPUT,
  Q_REQUEST_SATISFIED,
} from '../src/codex/subagent.js';

const tempEnv = (raw: Record<string, unknown> = {}): NodeJS.ProcessEnv => {
  const dir = mkdtempSync(join(tmpdir(), 'cd-subagent-'));
  const env = { PLUGIN_DATA: dir } as NodeJS.ProcessEnv;
  writeFileSync(configPath(env), JSON.stringify(raw));
  return env;
};

const message = 'the payment test fails on line 182 because the fixture is stale\n'.repeat(20);

const stopPayload = (over: Record<string, unknown> = {}) => ({
  hook_event_name: 'SubagentStop',
  agent_id: 'a1',
  agent_type: 'explorer',
  last_assistant_message: message,
  stop_hook_active: false,
  ...over,
});

const scores = (over: Record<string, number> = {}): Record<string, number> => ({
  [Q_ANSWER_ACTIONABLE]: 0.9,
  [Q_EVIDENCE_PRESENT]: 0.9,
  [Q_REDUNDANT_OUTPUT]: 0.1,
  [Q_REQUEST_SATISFIED]: 0.9,
  ...over,
});

const answering = (over: Record<string, number> = {}): string => JSON.stringify(scores(over));

describe('the subagent contract', () => {
  it('is injected on SubagentStart and recorded', async () => {
    const env = tempEnv({ debug: true });
    const out = await handleSubagent({ hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'explorer' }, env);
    const parsed = JSON.parse(out) as Record<string, unknown>;
    const hook = parsed.hookSpecificOutput as Record<string, unknown>;
    expect(hook.hookEventName).toBe('SubagentStart');
    expect(String(hook.additionalContext)).toContain('conclusion');
    expect(String(hook.additionalContext)).toContain('Do not include full raw logs');
    expect(readFileSync(logPath(env), 'utf8')).toContain('"kind":"subagent_start"');
  });
});

describe('the subagent stop guard', () => {
  it('allows a concise, evidence-backed result', async () => {
    const env = tempEnv({ debug: true });
    env.CONTEXT_DIET_TEST_ANSWERS = answering();
    expect(await handleSubagent(stopPayload(), env)).toBe('');
    const log = readFileSync(logPath(env), 'utf8');
    expect(log).toContain('"kind":"subagent_verdict"');
    expect(log).toContain('"action":"allow"');
  });

  it('asks for a revision when the result is padded with raw output', async () => {
    const env = tempEnv();
    env.CONTEXT_DIET_TEST_ANSWERS = answering({ [Q_REDUNDANT_OUTPUT]: 0.95 });
    const parsed = JSON.parse(await handleSubagent(stopPayload(), env)) as Record<string, unknown>;
    expect(parsed.decision).toBe('block');
    expect(String(parsed.reason)).toContain('Condense the response');
  });

  it('asks for a revision when the evidence or the request is missing', async () => {
    const env = tempEnv();
    env.CONTEXT_DIET_TEST_ANSWERS = answering({ [Q_EVIDENCE_PRESENT]: 0.1 });
    const parsed = JSON.parse(await handleSubagent(stopPayload(), env)) as Record<string, unknown>;
    expect(String(parsed.reason)).toContain('evidence-backed');
    const second = tempEnv();
    second.CONTEXT_DIET_TEST_ANSWERS = answering({ [Q_REQUEST_SATISFIED]: 0.2 });
    expect(String((JSON.parse(await handleSubagent(stopPayload(), second)) as Record<string, unknown>).reason)).toContain('Finish the request');
  });

  it('never intervenes twice for the same agent', async () => {
    const env = tempEnv();
    env.CONTEXT_DIET_TEST_ANSWERS = answering({ [Q_REDUNDANT_OUTPUT]: 0.95 });
    expect(await handleSubagent(stopPayload(), env)).toContain('block');
    expect(await handleSubagent(stopPayload(), env)).toBe('');
  });

  it('respects stop_hook_active and short messages', async () => {
    const env = tempEnv();
    env.CONTEXT_DIET_TEST_ANSWERS = answering({ [Q_REDUNDANT_OUTPUT]: 0.95 });
    expect(await handleSubagent(stopPayload({ stop_hook_active: true }), env)).toBe('');
    expect(await handleSubagent(stopPayload({ last_assistant_message: 'done' }), env)).toBe('');
  });

  it('fails open when the guard is off or the answers are malformed', async () => {
    const off = tempEnv({ subagentGuard: false });
    off.CONTEXT_DIET_TEST_ANSWERS = answering({ [Q_REDUNDANT_OUTPUT]: 0.95 });
    expect(await handleSubagent(stopPayload(), off)).toBe('');
    const broken = tempEnv();
    broken.CONTEXT_DIET_TEST_ANSWERS = '{}';
    expect(await handleSubagent(stopPayload(), broken)).toBe('');
  });

  it('never throws on an unexpected payload', async () => {
    const env = tempEnv();
    expect(await handleSubagent({ hook_event_name: 'SubagentStop' }, env)).toBe('');
    expect(await handleSubagent({}, env)).toBe('');
  });
});

