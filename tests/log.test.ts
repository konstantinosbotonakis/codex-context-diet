import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type DietConfig } from '../src/config.js';
import { appendEvent, logPath, rotateLog } from '../src/codex/log.js';

const NOW = new Date('2026-09-18T12:00:00Z');
const at = (daysAgo: number): string => new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString();
const line = (daysAgo: number, tag: string): string => JSON.stringify({ at: at(daysAgo), kind: 'diet', tag });
const CORRUPT = 'not json at all';

const tempEnv = (): NodeJS.ProcessEnv =>
  ({ PLUGIN_DATA: mkdtempSync(join(tmpdir(), 'cd-log-')) } as NodeJS.ProcessEnv);

const debugConfig = (over: Partial<DietConfig> = {}): DietConfig =>
  ({ ...DEFAULT_CONFIG, debug: true, ...over });

const writeLog = (env: NodeJS.ProcessEnv, lines: string[]): void => {
  mkdirSync(join(env.PLUGIN_DATA as string, 'log'), { recursive: true });
  writeFileSync(logPath(env), lines.join('\n') + '\n');
};

const readLog = (env: NodeJS.ProcessEnv): string[] =>
  readFileSync(logPath(env), 'utf8').split('\n').filter((item) => item.trim().length > 0);

describe('log rotation', () => {
  it('drops events past the window, keeps the rest, and keeps corrupt lines', () => {
    const env = tempEnv();
    writeLog(env, [line(40, 'too-old'), line(31, 'just-old'), line(29, 'recent'), line(2, 'newer'), CORRUPT]);
    expect(rotateLog(env, debugConfig(), NOW)).toBe(true);
    expect(readLog(env)).toEqual([line(29, 'recent'), line(2, 'newer'), CORRUPT]);
  });

  it('rotates at most once a day', () => {
    const env = tempEnv();
    writeLog(env, [line(40, 'too-old'), line(2, 'kept')]);
    expect(rotateLog(env, debugConfig(), NOW)).toBe(true);
    writeFileSync(logPath(env), readFileSync(logPath(env), 'utf8') + line(40, 'added-after') + '\n');
    expect(rotateLog(env, debugConfig(), NOW)).toBe(false);
    expect(readLog(env)).toHaveLength(2);
    const tomorrow = new Date(NOW.getTime() + 86_400_000);
    expect(rotateLog(env, debugConfig(), tomorrow)).toBe(true);
    expect(readLog(env)).toEqual([line(2, 'kept')]);
  });

  it('keeps everything when logRetentionDays is 0', () => {
    const env = tempEnv();
    writeLog(env, [line(400, 'ancient')]);
    expect(rotateLog(env, debugConfig({ logRetentionDays: 0 }), NOW)).toBe(false);
    expect(readLog(env)).toEqual([line(400, 'ancient')]);
  });

  it('does nothing when there is no log yet', () => {
    expect(rotateLog(tempEnv(), debugConfig(), NOW)).toBe(false);
  });

  it('rotates after an append, so one append pays for the whole day', () => {
    const env = tempEnv();
    writeLog(env, [line(40, 'too-old')]);
    appendEvent(env, debugConfig(), { kind: 'diet', reason: 'kept' });
    const lines = readLog(env);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toMatchObject({ kind: 'diet', reason: 'kept' });
  });
});

