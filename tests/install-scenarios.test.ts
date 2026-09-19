import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appendCache, cachePath, readCache, type CacheEntry } from '../src/cache.js';
import { configPath, DEFAULT_CONFIG } from '../src/config.js';
import { main as adapterMain } from '../src/codex/adapter.js';
import { logPath } from '../src/codex/log.js';
import { main as sessionMain } from '../src/codex/session.js';

const tempEnv = (raw: Record<string, unknown> = {}): NodeJS.ProcessEnv => {
  const dir = mkdtempSync(join(tmpdir(), 'cd-install-'));
  const env = { ...process.env, PLUGIN_DATA: dir, HOME: dir, TYPESAFE_KEY_FILE: join(dir, 'no-key-here') } as NodeJS.ProcessEnv;
  delete env.TYPESAFE_API_KEY;
  writeFileSync(configPath(env), JSON.stringify(raw));
  return env;
};

const dropAnswers = JSON.stringify({
  needs_contents: 0.05, replaceable: 0.9, keep_call: 0.9, agent_directed: 0.02, behaviour_change: 0.02,
});

const payload = (id: string, body: string): string =>
  JSON.stringify({
    hook_event_name: 'PostToolUse', session_id: 's1', tool_name: 'Bash', tool_use_id: id,
    tool_input: { command: 'npm test' }, tool_response: { output: body },
  });

const seed: CacheEntry = {
  tool_use_id: 'seed', tool_name: 'Read', at: '2026-09-19T00:00:00.000Z', input: 'src/seed.ts',
  head: 'digest', tail: '', chars: 20, decision: 'keep', goal_index: 0,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('upgrades', () => {
  it('keeps working with a 0.5.x config and an old cache line', async () => {
    const env = tempEnv({ enabled: true, mode: 'diet', minTokens: 10, debug: true, privacyMode: 'strict' });
    env.CONTEXT_DIET_TEST_ANSWERS = dropAnswers;
    // A cache line written before the newer fields existed.
    mkdirSync(join(env.PLUGIN_DATA as string, 'sessions'), { recursive: true });
    const old = { tool_use_id: 'old', tool_name: 'Bash', at: '2026-09-18T00:00:00.000Z', input: 'npm test', head: 'h', tail: 't', chars: 400, decision: 'keep', goal_index: 0 };
    writeFileSync(cachePath(env, 's1'), JSON.stringify(old) + '\n');
    const out = await adapterMain(payload('t1', 'x'.repeat(4000)), env);
    expect(JSON.parse(out).decision).toBe('block');
    const entries = readCache(env, 's1', { ...DEFAULT_CONFIG, minTokens: 10 });
    expect(entries[0]?.tool_use_id).toBe('old');
    expect(entries.length).toBe(2);
  });

  it('keeps working with a 0.6.0 config written by the previous release', async () => {
    const env = tempEnv({ ...DEFAULT_CONFIG, minTokens: 10, debug: true });
    env.CONTEXT_DIET_TEST_ANSWERS = dropAnswers;
    appendCache(env, 's1', seed, DEFAULT_CONFIG);
    const out = await adapterMain(payload('t1', 'y'.repeat(4000)), env);
    expect(JSON.parse(out).decision).toBe('block');
  });
});

describe('key failures fail open', () => {
  it('keeps every result and warns once when no key exists', async () => {
    const env = tempEnv({ debug: true, minTokens: 10 });
    appendCache(env, 's1', seed, DEFAULT_CONFIG);
    const first = JSON.parse(await adapterMain(payload('t1', 'z'.repeat(4000)), env)) as Record<string, unknown>;
    expect(first.decision).toBeUndefined();
    expect(String(first.systemMessage)).toContain('no TypeSafe API key');
    expect(readFileSync(logPath(env), 'utf8')).toContain('key_missing');
    // The same session is never warned twice.
    const second = await adapterMain(payload('t2', 'w'.repeat(4000)), env);
    expect(second).toBe('');
  });

  it('keeps every result and warns once when TypeSafe rejects the key', async () => {
    const env = tempEnv({ debug: true, minTokens: 10, apiKey: 'bad-key' });
    appendCache(env, 's1', seed, DEFAULT_CONFIG);
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('invalid api key', { status: 401 })));
    const out = JSON.parse(await adapterMain(payload('t1', 'v'.repeat(4000)), env)) as Record<string, unknown>;
    expect(out.decision).toBeUndefined();
    expect(String(out.systemMessage)).toContain('rejected the API key');
    expect(readFileSync(logPath(env), 'utf8')).toContain('key_rejected');
  });

  it('says nothing on a first result, because Jev was never going to run', async () => {
    const env = tempEnv({ debug: true, minTokens: 10 });
    expect(await adapterMain(payload('t1', 'u'.repeat(4000)), env)).toBe('');
  });

  it('reports the warning from the session hook as developer context', async () => {
    // The session-level warning rides on the prompt guard, which is opt-in.
    const env = tempEnv({ debug: true, minTokens: 10, promptGuard: true });
    const out = await sessionMain(
      JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'fix the failing test' }),
      env,
    );
    expect(out).toContain('no TypeSafe API key');
  });
});

describe('quiet configurations', () => {
  it('does nothing at all when the plugin is disabled', async () => {
    const env = tempEnv({ enabled: false });
    env.CONTEXT_DIET_TEST_ANSWERS = dropAnswers;
    appendCache(env, 's1', seed, DEFAULT_CONFIG);
    expect(await adapterMain(payload('t1', 't'.repeat(4000)), env)).toBe('');
    expect(await sessionMain(JSON.stringify({ hook_event_name: 'SessionStart', session_id: 's1' }), env)).toBe('');
  });

  it('writes no session state when stateSource is off', async () => {
    const env = tempEnv({ stateSource: 'off', minTokens: 10 });
    env.CONTEXT_DIET_TEST_ANSWERS = dropAnswers;
    await sessionMain(JSON.stringify({ hook_event_name: 'SessionStart', session_id: 's1' }), env);
    await sessionMain(JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'ship it' }), env);
    const out = await adapterMain(payload('t1', 's'.repeat(4000)), env);
    // Single-turn still judges, but nothing is read from or written to disk.
    expect(JSON.parse(out).decision).toBe('block');
    expect(() => readFileSync(cachePath(env, 's1'), 'utf8')).toThrow();
  });
});
