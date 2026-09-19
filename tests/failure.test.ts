import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cachePath } from '../src/cache.js';
import { configPath, DEFAULT_CONFIG } from '../src/config.js';
import { main as adapterMain } from '../src/codex/adapter.js';
import { createAsker } from '../src/codex/transport.js';

const tempEnv = (raw: Record<string, unknown>): NodeJS.ProcessEnv => {
  const dir = mkdtempSync(join(tmpdir(), 'cd-failure-'));
  const env = { PLUGIN_DATA: dir } as NodeJS.ProcessEnv;
  writeFileSync(configPath(env), JSON.stringify(raw));
  return env;
};

const payload = (id: string, body: string): string =>
  JSON.stringify({
    hook_event_name: 'PostToolUse', session_id: 's1', tool_name: 'Bash', tool_use_id: id,
    tool_input: { command: 'npm test' }, tool_response: { output: body },
  });

const dropAnswers = JSON.stringify({
  needs_contents: 0.05, replaceable: 0.9, keep_call: 0.9, agent_directed: 0.02, behaviour_change: 0.02,
});

const questions = { ping: { type: 'noul' as const, instructions: 'This model is reachable' } };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('timeouts and transport failures', () => {
  it('aborts a hanging request at requestTimeoutMs', async () => {
    vi.stubGlobal('fetch', (_url: string, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('This operation was aborted')));
      }),
    );
    const asker = createAsker({ ...DEFAULT_CONFIG, requestTimeoutMs: 150 }, 'test-key', {});
    const started = Date.now();
    await expect(asker.ask('state', questions)).rejects.toThrow('aborted');
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('turns an HTTP error into a rejection, never into an answer', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('upstream exploded', { status: 500 })));
    const asker = createAsker(DEFAULT_CONFIG, 'test-key', {});
    await expect(asker.ask('state', questions)).rejects.toThrow(/Jev request failed \(500\)/);
  });

  it('surfaces a network failure instead of inventing a decision', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('ECONNREFUSED')));
    const asker = createAsker(DEFAULT_CONFIG, 'test-key', {});
    await expect(asker.ask('state', questions)).rejects.toThrow('ECONNREFUSED');
  });
});

describe('storage failures fail open', () => {
  it('treats an unreadable cache as an empty session', async () => {
    const env = tempEnv({ debug: true, minTokens: 10 });
    env.CONTEXT_DIET_TEST_ANSWERS = dropAnswers;
    const cacheFile = cachePath(env, 's1');
    mkdirSync(dirname(cacheFile), { recursive: true });
    writeFileSync(cacheFile, 'not json at all\n');
    // With no readable history the result is the first of the session, so it
    // is kept. The point is that the corrupt file never throws.
    expect(await adapterMain(payload('t1', 'x'.repeat(600)), env)).toBe('');
  });

  it('still answers when the data directory cannot be created', async () => {
    const blocker = mkdtempSync(join(tmpdir(), 'cd-blocker-'));
    const file = join(blocker, 'not-a-dir');
    writeFileSync(file, 'x');
    const env = {
      PLUGIN_DATA: join(file, 'data'),
      CONTEXT_DIET_TEST_ANSWERS: dropAnswers,
    } as NodeJS.ProcessEnv;
    await expect(adapterMain(payload('t1', 'x'.repeat(600)), env)).resolves.toBe('');
  });
});

describe('huge inputs stay bounded', () => {
  it('replaces a very large result with a bounded capsule', async () => {
    const env = tempEnv({ debug: true, minTokens: 10 });
    env.CONTEXT_DIET_TEST_ANSWERS = dropAnswers;
    await adapterMain(payload('t1', 'x'.repeat(600)), env);
    const started = Date.now();
    const output = await adapterMain(payload('t2', 'y'.repeat(2_000_000)), env);
    const elapsed = Date.now() - started;
    const decision = JSON.parse(output) as Record<string, unknown>;
    expect(decision.decision).toBe('block');
    expect(output.length).toBeLessThan(8000);
    expect(elapsed).toBeLessThan(3000);
  });

  it('keeps a huge result silent when the size gate is not met', async () => {
    const env = tempEnv({ debug: true, minTokens: 100_000 });
    env.CONTEXT_DIET_TEST_ANSWERS = dropAnswers;
    await adapterMain(payload('t1', 'x'.repeat(600)), env);
    expect(await adapterMain(payload('t2', 'y'.repeat(2_000_000)), env)).toBe('');
  });
});

