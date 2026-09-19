import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { appendCache, appendRecovery, appendTouch, type CacheEntry } from '../src/cache.js';
import { configPath, DEFAULT_CONFIG, type DietConfig } from '../src/config.js';
import { buildSnapshot, handleCompaction, resurrectionPath, takeResurrection } from '../src/codex/compaction.js';
import { logPath } from '../src/codex/log.js';
import { main as sessionMain } from '../src/codex/session.js';

const tempEnv = (raw: Record<string, unknown> = {}): NodeJS.ProcessEnv => {
  const dir = mkdtempSync(join(tmpdir(), 'cd-compact-'));
  const env = { PLUGIN_DATA: dir } as NodeJS.ProcessEnv;
  writeFileSync(configPath(env), JSON.stringify(raw));
  return env;
};

const entry = (n: number, decision: string): CacheEntry => ({
  tool_use_id: 't' + n, tool_name: 'Bash', at: new Date().toISOString(), input: 'npm test -- ' + n,
  head: 'head', tail: 'tail', chars: 1000 + n, decision, goal_index: 0, reason: 'stale and reproducible, body omitted',
});

const prompt = (text: string): string =>
  JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: text, cwd: '/tmp' });

const seed = async (env: NodeJS.ProcessEnv, config: DietConfig): Promise<void> => {
  await sessionMain(prompt('fix the failing payment test'), env);
  appendCache(env, 's1', entry(1, 'drop_result'), config);
  appendCache(env, 's1', entry(2, 'drop_result'), config);
  appendCache(env, 's1', entry(3, 'keep'), config);
  appendTouch(env, 's1', { at: new Date().toISOString(), tool: 'apply_patch', paths: ['src/payment.ts'] });
  appendRecovery(env, 's1', {
    of: 't1', inputHash: 'hash', at: new Date().toISOString(), tool: 'Bash', afterMs: 1000, afterCalls: 2, input: 'npm test',
  });
};

describe('the compaction snapshot', () => {
  it('carries the goal, the writes, the removed outputs and the reruns', async () => {
    const env = tempEnv();
    const config = { ...DEFAULT_CONFIG };
    await seed(env, config);
    const snapshot = buildSnapshot(env, 's1', config);
    expect(snapshot).toContain('[codex-context-diet resurrection]');
    expect(snapshot).toContain('Goal: fix the failing payment test');
    expect(snapshot).toContain('Files written: src/payment.ts');
    expect(snapshot).toContain('Outputs removed');
    expect(snapshot).toContain('npm test -- 1');
    expect(snapshot).toContain('Recent decisions');
    expect(snapshot).toContain('Re-runs of dropped output');
    expect(snapshot).toContain('npm test');
  });

  it('stays inside the configured bound', async () => {
    const env = tempEnv();
    const config = { ...DEFAULT_CONFIG, snapshotMaxChars: 80 };
    await seed(env, config);
    expect(buildSnapshot(env, 's1', config).length).toBeLessThanOrEqual(80);
  });

  it('says nothing when there is nothing to say', () => {
    const env = tempEnv();
    expect(buildSnapshot(env, 'fresh', DEFAULT_CONFIG)).toBe('');
  });
});

describe('resurrection around a compaction', () => {
  it('writes on PreCompact and rides the next prompt exactly once', async () => {
    const env = tempEnv();
    const config = { ...DEFAULT_CONFIG };
    await seed(env, config);
    expect(await handleCompaction({ hook_event_name: 'PreCompact', session_id: 's1', trigger: 'auto' }, env)).toBe('');
    expect(readFileSync(resurrectionPath(env, 's1'), 'utf8').trim().length).toBeGreaterThan(0);
    const first = await sessionMain(prompt('carry on'), env);
    expect(first).toContain('[codex-context-diet resurrection]');
    expect(first).toContain('fix the failing payment test');
    const second = await sessionMain(prompt('one more thing'), env);
    expect(second).not.toContain('[codex-context-diet resurrection]');
  });

  it('records PostCompact without adding context', async () => {
    const env = tempEnv({ debug: true });
    expect(await handleCompaction({ hook_event_name: 'PostCompact', session_id: 's1', trigger: 'manual' }, env)).toBe('');
    expect(readFileSync(logPath(env), 'utf8')).toContain('"phase":"post"');
  });

  it('fails open with no state at all', async () => {
    const env = tempEnv();
    expect(await handleCompaction({ hook_event_name: 'PreCompact', session_id: 'unknown', trigger: 'auto' }, env)).toBe('');
    expect(takeResurrection(env, 'unknown', DEFAULT_CONFIG)).toBeNull();
  });

  it('does nothing when the feature is off', async () => {
    const env = tempEnv({ compactionResurrection: false });
    const config = { ...DEFAULT_CONFIG, compactionResurrection: false };
    await seed(env, config);
    expect(buildSnapshot(env, 's1', config)).not.toBe('');
    await handleCompaction({ hook_event_name: 'PreCompact', session_id: 's1', trigger: 'auto' }, env);
    expect(takeResurrection(env, 's1', config)).toBeNull();
  });
});

