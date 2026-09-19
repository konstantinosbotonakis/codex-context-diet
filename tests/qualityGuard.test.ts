import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { configPath } from '../src/config.js';
import { logPath } from '../src/codex/log.js';
import {
  handleStop,
  Q_KNOWN_FAILURE,
  Q_REQUEST_SATISFIED,
  Q_UNSUPPORTED_CLAIM,
  Q_VERIFICATION_COMPLETE,
} from '../src/codex/qualityGuard.js';

const tempEnv = (raw: Record<string, unknown> = {}): NodeJS.ProcessEnv => {
  const dir = mkdtempSync(join(tmpdir(), 'cd-quality-'));
  const env = { PLUGIN_DATA: dir } as NodeJS.ProcessEnv;
  writeFileSync(configPath(env), JSON.stringify(raw));
  return env;
};

const message = 'I updated the parser and ran the suite; all tests pass now.\n'.repeat(12);

const payload = (over: Record<string, unknown> = {}) => ({
  turn_id: 't1',
  last_assistant_message: message,
  stop_hook_active: false,
  ...over,
});

const scores = (over: Record<string, number> = {}): string =>
  JSON.stringify({
    [Q_REQUEST_SATISFIED]: 0.9,
    [Q_VERIFICATION_COMPLETE]: 0.9,
    [Q_KNOWN_FAILURE]: 0.1,
    [Q_UNSUPPORTED_CLAIM]: 0.1,
    ...over,
  });

describe('the stop quality guard', () => {
  it('is off by default', async () => {
    const env = tempEnv({ debug: true });
    env.CONTEXT_DIET_TEST_ANSWERS = scores({ [Q_KNOWN_FAILURE]: 0.99 });
    expect(await handleStop(payload(), env)).toBe('');
    // Off means off: nothing is even logged.
    expect(existsSync(logPath(env))).toBe(false);
  });

  it('allows a verified completion', async () => {
    const env = tempEnv({ qualityGuard: true, debug: true });
    env.CONTEXT_DIET_TEST_ANSWERS = scores();
    expect(await handleStop(payload(), env)).toBe('');
    expect(readFileSync(logPath(env), 'utf8')).toContain('"action":"allow"');
  });

  it('continues when verification is incomplete', async () => {
    const env = tempEnv({ qualityGuard: true });
    env.CONTEXT_DIET_TEST_ANSWERS = scores({ [Q_VERIFICATION_COMPLETE]: 0.2 });
    const parsed = JSON.parse(await handleStop(payload(), env)) as Record<string, unknown>;
    expect(parsed.decision).toBe('block');
    expect(String(parsed.reason)).toContain('Run the relevant test suite');
  });

  it('puts an unresolved failure and an unsupported claim first', async () => {
    const env = tempEnv({ qualityGuard: true });
    env.CONTEXT_DIET_TEST_ANSWERS = scores({ [Q_KNOWN_FAILURE]: 0.95, [Q_VERIFICATION_COMPLETE]: 0.1 });
    expect(String((JSON.parse(await handleStop(payload(), env)) as Record<string, unknown>).reason)).toContain('known failure');
    const second = tempEnv({ qualityGuard: true });
    second.CONTEXT_DIET_TEST_ANSWERS = scores({ [Q_UNSUPPORTED_CLAIM]: 0.95, [Q_VERIFICATION_COMPLETE]: 0.1 });
    expect(String((JSON.parse(await handleStop(payload(), second)) as Record<string, unknown>).reason)).toContain('unsupported');
  });

  it('continues when the request is not satisfied', async () => {
    const env = tempEnv({ qualityGuard: true });
    env.CONTEXT_DIET_TEST_ANSWERS = scores({ [Q_REQUEST_SATISFIED]: 0.2 });
    expect(String((JSON.parse(await handleStop(payload(), env)) as Record<string, unknown>).reason)).toContain('not satisfied yet');
  });

  it('never intervenes twice for the same turn', async () => {
    const env = tempEnv({ qualityGuard: true });
    env.CONTEXT_DIET_TEST_ANSWERS = scores({ [Q_VERIFICATION_COMPLETE]: 0.1 });
    expect(await handleStop(payload(), env)).toContain('block');
    expect(await handleStop(payload(), env)).toBe('');
  });

  it('respects stop_hook_active and short messages', async () => {
    const env = tempEnv({ qualityGuard: true });
    env.CONTEXT_DIET_TEST_ANSWERS = scores({ [Q_VERIFICATION_COMPLETE]: 0.1 });
    expect(await handleStop(payload({ stop_hook_active: true }), env)).toBe('');
    expect(await handleStop(payload({ last_assistant_message: 'done' }), env)).toBe('');
  });

  it('fails open on malformed answers and unexpected payloads', async () => {
    const env = tempEnv({ qualityGuard: true });
    env.CONTEXT_DIET_TEST_ANSWERS = '{}';
    expect(await handleStop(payload(), env)).toBe('');
    expect(await handleStop({}, env)).toBe('');
  });
});
