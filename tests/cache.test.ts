import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { appendCache, cachePath, countSessions, readCache, sessionKey, type CacheEntry } from '../src/cache.js';
import { DEFAULT_CONFIG } from '../src/config.js';

const tempEnv = (): NodeJS.ProcessEnv =>
  ({ PLUGIN_DATA: mkdtempSync(join(tmpdir(), 'cd-cache-')) } as NodeJS.ProcessEnv);

const entry = (n: number): CacheEntry => ({
  tool_use_id: 'tool-' + n, tool_name: 'Bash', at: '2026-09-18T00:00:00.000Z',
  input: 'npm test -- ' + n, head: 'h'.repeat(120), tail: 't'.repeat(80), chars: 100 + n,
  decision: 'drop_result', goal_index: 0,
});

describe('cache', () => {
  it('maps a hostile session id to one flat name', () => {
    expect(sessionKey('../../etc/passwd')).not.toContain('/');
    expect(sessionKey('a'.repeat(200)).length).toBe(128);
    expect(sessionKey('')).toBe('unknown');
    expect(cachePath({ PLUGIN_DATA: '/tmp/x' } as NodeJS.ProcessEnv, '../../etc/passwd'))
      .toContain('/tmp/x/sessions/');
  });

  it('round-trips an entry', () => {
    const env = tempEnv();
    const first = entry(1);
    appendCache(env, 's1', first, DEFAULT_CONFIG);
    expect(readCache(env, 's1')).toEqual([first]);
    expect(countSessions(env)).toBe(1);
  });

  it('skips corrupt lines instead of failing', () => {
    const env = tempEnv();
    appendCache(env, 's1', entry(1), DEFAULT_CONFIG);
    writeFileSync(cachePath(env, 's1'), 'not json\n\n' + JSON.stringify(entry(2)) + '\n');
    expect(readCache(env, 's1').map((item) => item.tool_use_id)).toEqual(['tool-2']);
  });

  it('returns at most cacheMaxEntries, newest last', () => {
    const env = tempEnv();
    for (let i = 1; i <= 5; i += 1) appendCache(env, 's1', entry(i), DEFAULT_CONFIG);
    const config = { ...DEFAULT_CONFIG, cacheMaxEntries: 3 };
    expect(readCache(env, 's1', config).map((item) => item.tool_use_id)).toEqual([
      'tool-3', 'tool-4', 'tool-5',
    ]);
  });

  it('keeps the file bounded by cacheMaxBytes', () => {
    const env = tempEnv();
    const config = { ...DEFAULT_CONFIG, cacheMaxBytes: 2000 };
    for (let i = 1; i <= 20; i += 1) appendCache(env, 's1', entry(i), config);
    expect(statSync(cachePath(env, 's1')).size).toBeLessThan(2600);
    expect(readCache(env, 's1').length).toBeGreaterThan(0);
  });

  it('appends without rewriting the whole file', () => {
    const env = tempEnv();
    appendCache(env, 's1', entry(1), DEFAULT_CONFIG);
    appendCache(env, 's1', entry(2), DEFAULT_CONFIG);
    const lines = readFileSync(cachePath(env, 's1'), 'utf8').trim().split('\n');
    expect(lines.map((line) => JSON.parse(line).tool_use_id)).toEqual(['tool-1', 'tool-2']);
  });
});
