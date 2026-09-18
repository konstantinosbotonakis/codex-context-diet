import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { main as dietMain } from '../src/codex/adapter.js';
import { readGoal, main as sessionMain } from '../src/codex/session.js';
import { appendCache, readCache, type CacheEntry } from '../src/cache.js';
import { DEFAULT_CONFIG, configPath } from '../src/config.js';

const tempEnv = (): NodeJS.ProcessEnv =>
  ({ PLUGIN_DATA: mkdtempSync(join(tmpdir(), 'cd-adapter-')) } as NodeJS.ProcessEnv);

const bigText = (): string => 'npm test output line 12345\n'.repeat(600);

const payload = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    session_id: 's1',
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_use_id: 'tool-1',
    tool_input: { command: 'npm test' },
    tool_response: { output: bigText() },
    cwd: '/tmp',
    model: 'gpt-6-astra',
    ...over,
  });

const seed: CacheEntry = {
  tool_use_id: 'tool-0', tool_name: 'Read', at: '2026-09-18T00:00:00.000Z', input: 'src/a.ts',
  head: 'export const a = 1;', tail: '', chars: 2000, decision: 'keep', goal_index: 0,
};

describe('PostToolUse adapter', () => {
  it('is silent for malformed input, other events, and patch output', async () => {
    const env = tempEnv();
    expect(await dietMain('not json', env)).toBe('');
    expect(await dietMain('', env)).toBe('');
    expect(await dietMain('{}', env)).toBe('');
    expect(await dietMain(payload({ hook_event_name: 'SessionStart' }), env)).toBe('');
    expect(await dietMain(payload({ tool_name: 'apply_patch' }), env)).toBe('');
    expect(await dietMain(payload({ tool_name: 'Edit' }), env)).toBe('');
    expect(await dietMain(payload({ tool_response: null }), env)).toBe('');
  });

  it('never reaches the network below the token floor', async () => {
    const env = { ...tempEnv(), CONTEXT_DIET_TEST_ANSWERS: 'not-json-at-all' };
    expect(await dietMain(payload({ tool_response: { output: 'tiny' } }), env)).toBe('');
  });

  it('is silent when the plugin is disabled', async () => {
    const env = tempEnv();
    writeFileSync(configPath(env), JSON.stringify({ enabled: false }));
    expect(await dietMain(payload(), env)).toBe('');
  });

  it('never diets the first result in a session, and records it', async () => {
    const env = { ...tempEnv(), CONTEXT_DIET_TEST_ANSWERS: '{"keep_result":0.01,"keep_call":0.01}' };
    expect(await dietMain(payload(), env)).toBe('');
    const cache = readCache(env, 's1');
    expect(cache).toHaveLength(1);
    expect(cache[0]?.decision).toBe('keep');
  });

  it('replaces a bulky result once the session has history', async () => {
    const env = { ...tempEnv(), CONTEXT_DIET_TEST_ANSWERS: '{"keep_result":0.05,"keep_call":0.9,"injection":0.02}' };
    appendCache(env, 's1', seed, DEFAULT_CONFIG);
    const parsed = JSON.parse(await dietMain(payload(), env)) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(['decision', 'hookSpecificOutput', 'reason']);
    expect(parsed.decision).toBe('block');
    expect(String(parsed.reason).startsWith(bigText().slice(0, 50))).toBe(true);
    expect(String(parsed.reason)).toContain('Re-run the tool if you need the full output.');
    const hook = parsed.hookSpecificOutput as Record<string, unknown>;
    expect(hook.hookEventName).toBe('PostToolUse');
    expect(readCache(env, 's1')).toHaveLength(2);
  });

  it('stays silent in dryRun while still recording the decision', async () => {
    const env = { ...tempEnv(), CONTEXT_DIET_TEST_ANSWERS: '{"keep_result":0.05,"keep_call":0.05,"injection":0.02}' };
    writeFileSync(configPath(env), JSON.stringify({ dryRun: true }));
    appendCache(env, 's1', seed, DEFAULT_CONFIG);
    expect(await dietMain(payload(), env)).toBe('');
    const cache = readCache(env, 's1');
    expect(cache).toHaveLength(2);
    expect(cache[1]?.decision).toBe('drop_result');
  });

  it('annotates instead of replacing when the injection guard fires', async () => {
    const env = { ...tempEnv(), CONTEXT_DIET_TEST_ANSWERS: '{"keep_result":0.05,"keep_call":0.05,"injection":0.95}' };
    appendCache(env, 's1', seed, DEFAULT_CONFIG);
    const parsed = JSON.parse(await dietMain(payload(), env)) as Record<string, unknown>;
    expect(parsed.decision).toBeUndefined();
    expect(Object.keys(parsed)).toEqual(['hookSpecificOutput']);
    const hook = parsed.hookSpecificOutput as Record<string, unknown>;
    expect(String(hook.additionalContext)).toContain('untrusted data');
  });

  it('honours neverDietTools', async () => {
    const env = { ...tempEnv(), CONTEXT_DIET_TEST_ANSWERS: '{"keep_result":0.01}' };
    writeFileSync(configPath(env), JSON.stringify({ neverDietTools: ['Bash'] }));
    appendCache(env, 's1', seed, DEFAULT_CONFIG);
    expect(await dietMain(payload(), env)).toBe('');
  });

  it('keeps single-turn state and writes nothing when stateSource is off', async () => {
    const env = { ...tempEnv(), CONTEXT_DIET_TEST_ANSWERS: '{"keep_result":0.05,"keep_call":0.9,"injection":0.02}' };
    writeFileSync(configPath(env), JSON.stringify({ stateSource: 'off' }));
    appendCache(env, 's1', seed, DEFAULT_CONFIG);
    const parsed = JSON.parse(await dietMain(payload(), env)) as Record<string, unknown>;
    expect(parsed.decision).toBe('block');
    expect(readCache(env, 's1')).toHaveLength(1);
  });
});

describe('session hook', () => {
  it('records a session and keeps the last three prompts', async () => {
    const env = tempEnv();
    expect(
      await sessionMain(
        JSON.stringify({ hook_event_name: 'SessionStart', session_id: 's1', cwd: '/tmp', model: 'm' }),
        env,
      ),
    ).toBe('');
    for (const prompt of ['one', '  ', 'two', 'three', 'four']) {
      await sessionMain(JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt }), env);
    }
    expect(readGoal(env, 's1')).toEqual({ goal: 'two\nthree\nfour', goalIndex: 2 });
  });

  it('survives malformed input and an unwritable directory', async () => {
    expect(await sessionMain('not json', tempEnv())).toBe('');
    expect(await sessionMain('{}', tempEnv())).toBe('');
    expect(await sessionMain(JSON.stringify({ hook_event_name: 'SessionStart', session_id: 's1' }), {
      PLUGIN_DATA: '/dev/null/nowhere',
    } as NodeJS.ProcessEnv)).toBe('');
  });
});
