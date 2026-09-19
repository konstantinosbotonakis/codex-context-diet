import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readRecoveries, recoveryPath, type CacheEntry } from '../src/cache.js';
import { configPath, DEFAULT_CONFIG } from '../src/config.js';
import { main as adapterMain } from '../src/codex/adapter.js';
import { cacheEntryOf, decideDiet, type DietAnswers, type DietInput } from '../src/codex/diet.js';
import { logPath } from '../src/codex/log.js';
import { classifyRecovery, detectRecovery, inputKey } from '../src/recovery.js';

const tempEnv = (config: Record<string, unknown> = {}): NodeJS.ProcessEnv => {
  const dir = mkdtempSync(join(tmpdir(), 'cd-recovery-'));
  const env = { PLUGIN_DATA: dir } as NodeJS.ProcessEnv;
  writeFileSync(configPath(env), JSON.stringify(config));
  return env;
};

const entry = (over: Partial<CacheEntry> = {}): CacheEntry => ({
  tool_use_id: 't1', tool_name: 'Bash', at: new Date(Date.now() - 5_000).toISOString(), input: 'npm test',
  head: '', tail: '', chars: 100, decision: 'drop_result', goal_index: 0,
  ...over,
});

const payload = (id: string, body: string): string =>
  JSON.stringify({
    hook_event_name: 'PostToolUse', session_id: 's1', tool_name: 'Bash', tool_use_id: id,
    tool_input: { command: 'npm test' }, tool_response: { output: body },
  });

describe('recovery inference', () => {
  it('matches a same-tool, same-input call inside the window', () => {
    const found = detectRecovery([entry()], [], { toolName: 'Bash', inputLine: 'npm test' }, Date.now(), 600_000);
    expect(found?.entry.tool_use_id).toBe('t1');
    expect(found?.afterCalls).toBeGreaterThanOrEqual(1);
  });

  it('ignores kept results, other tools, other inputs and the elapsed window', () => {
    const now = Date.now();
    expect(detectRecovery([entry({ decision: 'keep' })], [], { toolName: 'Bash', inputLine: 'npm test' }, now, 600_000)).toBeNull();
    expect(detectRecovery([entry()], [], { toolName: 'Read', inputLine: 'npm test' }, now, 600_000)).toBeNull();
    expect(detectRecovery([entry()], [], { toolName: 'Bash', inputLine: 'npm run build' }, now, 600_000)).toBeNull();
    expect(detectRecovery([entry({ at: new Date(now - 900_000).toISOString() })], [], { toolName: 'Bash', inputLine: 'npm test' }, now, 600_000)).toBeNull();
  });

  it('does not report the same drop twice, and forgives trailing spaces', () => {
    const now = Date.now();
    const seen = [inputKey('Bash', 'npm test')];
    expect(detectRecovery([entry()], seen, { toolName: 'Bash', inputLine: 'npm test' }, now, 600_000)).toBeNull();
    expect(detectRecovery([entry()], [], { toolName: 'Bash', inputLine: 'npm test  ' }, now, 600_000)).not.toBeNull();
  });

  it('records the bounded decision metadata on the entry', () => {
    const input: DietInput = {
      toolName: 'Bash', toolUseId: 't7', inputLine: 'npm test', resultText: 'x'.repeat(50), isError: false, goalIndex: 2,
    };
    const answers: DietAnswers = { keepCall: 0.9, needsContents: 0.05, replaceable: 0.9, injection: null };
    const entryOut = cacheEntryOf(input, decideDiet(answers, DEFAULT_CONFIG), '2026-09-19T00:00:00.000Z', 4);
    expect(entryOut.reason).toContain('stale');
    expect(entryOut.scores).toEqual({ keepCall: 0.9, needsContents: 0.05, replaceable: 0.9, injection: null });
    expect(entryOut.callIndex).toBe(4);
    expect(entryOut.hash).toHaveLength(64);
  });
});

describe('recovery telemetry through the hook', () => {
  const dropAnswers = JSON.stringify({
    needs_contents: 0.05, replaceable: 0.9, keep_call: 0.9, agent_directed: 0.02, behaviour_change: 0.02,
  });

  it('scores a rerun once and counts it in the log', async () => {
    const env = tempEnv({ debug: true, minTokens: 10 });
    env.CONTEXT_DIET_TEST_ANSWERS = dropAnswers;
    const first = payload('t1', 'run one output\n'.repeat(200));
    await adapterMain(first, env);
    await adapterMain(payload('t2', 'run two output\n'.repeat(200)), env);
    await adapterMain(payload('t3', 'run two output\n'.repeat(200)), env);
    await adapterMain(payload('t4', 'run two output\n'.repeat(200)), env);
    const log = readFileSync(logPath(env), 'utf8');
    const recoveries = log.split('\n').filter((line) => line.includes('"kind":"recovery"'));
    expect(recoveries).toHaveLength(1);
    expect(recoveries[0]).toContain('"of":"t2"');
    expect(readFileSync(recoveryPath(env, 's1'), 'utf8').trim().split('\n')).toHaveLength(1);
    expect(readRecoveries(env, 's1')[0]?.tool).toBe('Bash');
  });
});

describe('recovery classification', () => {
  const dropAt = new Date(Date.now() - 5_000).toISOString();
  const writeAt = new Date(Date.now() - 2_000).toISOString();
  const write = { at: writeAt, tool: 'Write', paths: ['/repo/src/app.ts'] };

  it('calls a rerun with nothing written in between a likely recovery', () => {
    const verdict = classifyRecovery(entry({ at: dropAt }), { toolName: 'Bash', inputLine: 'npm test' }, []);
    expect(verdict.classification).toBe('likely_recovery');
  });

  it('softens the verdict when something was written after the drop', () => {
    const verdict = classifyRecovery(entry({ at: dropAt }), { toolName: 'Bash', inputLine: 'npm test' }, [write]);
    expect(verdict.classification).toBe('possible_rerun');
  });

  it('calls a re-read of a file that changed an invalidated rerun', () => {
    const verdict = classifyRecovery(
      entry({ at: dropAt, tool_name: 'Read', input: '/repo/src/app.ts' }),
      { toolName: 'Read', inputLine: '/repo/src/app.ts' },
      [write],
    );
    expect(verdict.classification).toBe('invalidated_rerun');
  });

  it('treats an unknown write as dirty for every later read', () => {
    const verdict = classifyRecovery(
      entry({ at: dropAt, tool_name: 'Read', input: '/repo/src/app.ts' }),
      { toolName: 'Read', inputLine: '/repo/src/app.ts' },
      [{ at: writeAt, tool: 'Bash', paths: ['*'] }],
    );
    expect(verdict.classification).toBe('invalidated_rerun');
  });

  it('ignores touches that predate the drop', () => {
    const old = { at: new Date(Date.now() - 60_000).toISOString(), tool: 'Write', paths: ['/repo/src/app.ts'] };
    const verdict = classifyRecovery(entry({ at: dropAt }), { toolName: 'Bash', inputLine: 'npm test' }, [old]);
    expect(verdict.classification).toBe('likely_recovery');
  });

  it('treats a write in the same millisecond as later, like duplicate invalidation does', () => {
    const same = { at: dropAt, tool: 'Write', paths: ['/repo/src/app.ts'] };
    const verdict = classifyRecovery(entry({ at: dropAt }), { toolName: 'Bash', inputLine: 'npm test' }, [same]);
    expect(verdict.classification).toBe('possible_rerun');
  });

  it('records the classification with the rerun', async () => {
    const env = tempEnv({ debug: true, minTokens: 10 });
    env.CONTEXT_DIET_TEST_ANSWERS = JSON.stringify({
      needs_contents: 0.05, replaceable: 0.9, keep_call: 0.9, agent_directed: 0.02, behaviour_change: 0.02,
    });
    await adapterMain(payload('t1', 'run one output\n'.repeat(200)), env);
    // t2 is the first result that can be dropped, because t1 is exempt.
    await adapterMain(payload('t2', 'run two output\n'.repeat(200)), env);
    await adapterMain(
      JSON.stringify({
        hook_event_name: 'PostToolUse',
        session_id: 's1',
        tool_name: 'Write',
        tool_use_id: 'w1',
        tool_input: { file_path: '/repo/app.ts', content: 'x' },
        tool_response: { output: 'ok' },
      }),
      env,
    );
    await adapterMain(payload('t3', 'run two output\n'.repeat(200)), env);
    const records = readRecoveries(env, 's1');
    expect(records.at(-1)?.classification).toBe('possible_rerun');
  });
});
