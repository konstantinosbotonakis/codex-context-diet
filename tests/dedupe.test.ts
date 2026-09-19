import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readTouches, type CacheEntry } from '../src/cache.js';
import { configPath, DEFAULT_CONFIG, type DietConfig } from '../src/config.js';
import { main as adapterMain } from '../src/codex/adapter.js';
import { runDiet } from '../src/codex/diet.js';
import { DUPLICATE_REASON, fingerprint, findDuplicate, touchedPaths } from '../src/dedupe.js';

const tempEnv = (config: Record<string, unknown> = {}): NodeJS.ProcessEnv => {
  const dir = mkdtempSync(join(tmpdir(), 'cd-dedupe-'));
  const env = { PLUGIN_DATA: dir } as NodeJS.ProcessEnv;
  writeFileSync(configPath(env), JSON.stringify(config));
  return env;
};

const entry = (over: Partial<CacheEntry> = {}): CacheEntry => ({
  tool_use_id: 't1', tool_name: 'Bash', at: '2026-09-19T10:00:00.000Z', input: 'npm test',
  head: '', tail: '', chars: 10, decision: 'keep', goal_index: 0,
  ...over,
});

const text = 'identical output line\n'.repeat(400);
const payload = (id: string): string =>
  JSON.stringify({
    hook_event_name: 'PostToolUse', session_id: 's1', tool_name: 'Bash', tool_use_id: id,
    tool_input: { command: 'npm test' }, tool_response: { output: text },
  });

describe('duplicate detection', () => {
  it('normalises harmless differences before hashing', () => {
    const plain = fingerprint('Bash', 'npm test', 'a\nb\nc');
    expect(fingerprint('Bash', 'npm test', 'a  \nb\nc ')).toBe(plain);
    expect(fingerprint('Bash', 'npm test', '\u001b[31ma\u001b[0m\nb\nc')).toBe(plain);
    expect(fingerprint('Bash', 'npm test', 'a\nb\nc\n\n\n')).toBe(plain);
    expect(fingerprint('Bash', 'npm test', 'a\nb\nd')).not.toBe(plain);
  });

  it('finds an identical earlier result and nothing else', () => {
    const cache = [entry({ hash: fingerprint('Bash', 'npm test', 'same output') })];
    expect(findDuplicate('Bash', 'npm test', 'same output', cache, [])).not.toBeNull();
    expect(findDuplicate('Bash', 'npm test', 'different output', cache, [])).toBeNull();
    expect(findDuplicate('Bash', 'npm run build', 'same output', cache, [])).toBeNull();
    expect(findDuplicate('Bash', 'npm test', 'same output', [entry()], [])).toBeNull();
  });

  it('invalidates a file read when something wrote the file afterwards', () => {
    const read = entry({
      tool_name: 'Read', input: '/repo/src/a.ts', resource: '/repo/src/a.ts',
      at: '2026-09-19T10:00:00.000Z', hash: fingerprint('Read', '/repo/src/a.ts', 'contents'),
    });
    const before = { at: '2026-09-19T09:59:00.000Z', tool: 'apply_patch', paths: ['/repo/src/a.ts'] };
    const after = { at: '2026-09-19T10:00:01.000Z', tool: 'apply_patch', paths: ['/repo/src/a.ts'] };
    const unknown = { at: '2026-09-19T10:00:01.000Z', tool: 'Bash', paths: ['*'] };
    expect(findDuplicate('Read', '/repo/src/a.ts', 'contents', [read], [before])).not.toBeNull();
    expect(findDuplicate('Read', '/repo/src/a.ts', 'contents', [read], [after])).toBeNull();
    expect(findDuplicate('Read', '/repo/src/a.ts', 'contents', [read], [unknown])).toBeNull();
  });

  it('names the paths a patch touched, and stays vague about shell writes', () => {
    expect(touchedPaths('apply_patch', { command: '*** Begin Patch\n*** Update File: src/a.ts\n*** End Patch' })).toEqual(['src/a.ts']);
    expect(touchedPaths('Bash', { command: 'npm test > out.log' })).toEqual(['*']);
    expect(touchedPaths('Bash', { command: 'git status' })).toEqual([]);
    expect(touchedPaths('Read', { file_path: '/repo/a.ts' })).toEqual([]);
  });

  it('drops a duplicate without calling Jev', async () => {
    const explosive = { async ask() { throw new Error('Jev must not be called for a duplicate'); } };
    const outcome = await runDiet({
      input: { toolName: 'Bash', toolUseId: 't9', inputLine: 'npm test', resultText: text, isError: false, goalIndex: 0 },
      config: { ...DEFAULT_CONFIG, minTokens: 10 } as DietConfig,
      cache: [entry({ hash: fingerprint('Bash', 'npm test', text) })],
      asker: explosive as never,
      goal: 'fix it',
      firstResult: false,
      duplicate: true,
    } as never);
    expect(outcome.decision.reason).toBe(DUPLICATE_REASON);
    expect(outcome.blocked).toBe(true);
    expect(outcome.stdout?.decision).toBe('block');
    expect(String(outcome.note)).toContain('identical to an earlier call');
  });
});

describe('duplicate elimination through the hook', () => {
  it('drops a repeated result with no key and no Jev call', async () => {
    const env = tempEnv({ debug: true, minTokens: 10 });
    expect(await adapterMain(payload('t1'), env)).toBe('');
    const second = JSON.parse(await adapterMain(payload('t2'), env)) as Record<string, unknown>;
    expect(second.decision).toBe('block');
    expect(String(second.reason)).toContain('identical to an earlier call');
    const third = JSON.parse(await adapterMain(payload('t3'), env)) as Record<string, unknown>;
    expect(third.decision).toBe('block');
  });

  it('refuses to call a re-read a duplicate after a patch touched the file', async () => {
    const env = tempEnv({ debug: true, minTokens: 10 });
    const read = (id: string): string =>
      JSON.stringify({
        hook_event_name: 'PostToolUse', session_id: 's2', tool_name: 'Read', tool_use_id: id,
        tool_input: { file_path: '/repo/src/a.ts' }, tool_response: { output: text },
      });
    const patch = JSON.stringify({
      hook_event_name: 'PostToolUse', session_id: 's2', tool_name: 'apply_patch', tool_use_id: 'p1',
      tool_input: { command: '*** Begin Patch\n*** Update File: /repo/src/a.ts\n*** End Patch' },
      tool_response: { output: 'Done!' },
    });
    await adapterMain(read('r1'), env);
    await adapterMain(patch, env);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await adapterMain(read('r2'), env)).not.toContain('"decision"');
    expect(readTouches(env, 's2').some((touch) => touch.paths.includes('/repo/src/a.ts'))).toBe(true);
  });

  it('still drops an identical re-read when nothing was written', async () => {
    const env = tempEnv({ debug: true, minTokens: 10 });
    const read = (id: string): string =>
      JSON.stringify({
        hook_event_name: 'PostToolUse', session_id: 's3', tool_name: 'Read', tool_use_id: id,
        tool_input: { file_path: '/repo/src/b.ts' }, tool_response: { output: text },
      });
    await adapterMain(read('r1'), env);
    const second = JSON.parse(await adapterMain(read('r2'), env)) as Record<string, unknown>;
    expect(second.decision).toBe('block');
  });
});
