import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { appendCache, type CacheEntry } from '../src/cache.js';
import { configPath, DEFAULT_CONFIG, loadConfig, resolveConfig, saveConfig } from '../src/config.js';
import { main as adapterMain } from '../src/codex/adapter.js';
import { logPath } from '../src/codex/log.js';
import { headAnswers, layaHeadPath, layaPaths, mapLayaAnswers, resolveLayaPython } from '../src/providers/laya.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const tempEnv = (raw: Record<string, unknown> = {}): NodeJS.ProcessEnv => {
  const dir = mkdtempSync(join(tmpdir(), 'cd-provider-'));
  const env = { ...process.env, PLUGIN_DATA: dir, HOME: dir } as NodeJS.ProcessEnv;
  writeFileSync(configPath(env), JSON.stringify(raw));
  return env;
};

const seed: CacheEntry = {
  tool_use_id: 'seed', tool_name: 'Read', at: '2026-09-19T00:00:00.000Z', input: 'src/seed.ts',
  head: 'digest', tail: '', chars: 20, decision: 'keep', goal_index: 0,
};

const payload = (body: string): string =>
  JSON.stringify({
    hook_event_name: 'PostToolUse', session_id: 's1', tool_name: 'Bash', tool_use_id: 't1',
    tool_input: { command: 'npm test' }, tool_response: { output: body },
  });

describe('provider configuration', () => {
  it('defaults to Jev and keeps the Laya fields on their defaults', () => {
    const config = resolveConfig({});
    expect(config.provider).toBe('jev');
    expect(config.layaModel).toBe('convaiinnovations/laya');
    expect(config.layaSubfolder).toBe('multilingual');
    expect(config.layaTimeoutMs).toBe(20_000);
  });

  it('accepts the local provider and rejects an unknown one', () => {
    expect(resolveConfig({ provider: 'laya' }).provider).toBe('laya');
    expect(resolveConfig({ provider: 'somewhere-else' }).provider).toBe('jev');
    expect(resolveConfig({ provider: 'laya', layaSubfolder: 'typed-decisions' }).layaSubfolder).toBe('typed-decisions');
  });

  it('saves a patch without dropping the rest of the file', () => {
    const env = tempEnv({ minTokens: 1234, debug: true });
    saveConfig(env, { provider: 'laya' });
    const config = loadConfig(env);
    expect(config.provider).toBe('laya');
    expect(config.minTokens).toBe(1234);
    expect(config.debug).toBe(true);
    expect(JSON.parse(readFileSync(configPath(env), 'utf8')).minTokens).toBe(1234);
  });
});

describe('python resolution', () => {
  it('prefers the configured python, then the managed venv, then python3', () => {
    const env = tempEnv();
    expect(resolveLayaPython({ ...DEFAULT_CONFIG, layaPython: '/custom/python' }, env)).toBe('/custom/python');
    expect(resolveLayaPython(DEFAULT_CONFIG, env)).toBe('python3');
    const paths = layaPaths(env);
    mkdirSync(dirname(paths.venvPython), { recursive: true });
    writeFileSync(paths.venvPython, '#!/bin/sh\n');
    expect(resolveLayaPython(DEFAULT_CONFIG, env)).toBe(paths.venvPython);
  });
});

describe('answer mapping', () => {
  it('maps noul, choice and score answers into the plugin shape', () => {
    const questions = {
      a: { type: 'noul' as const, instructions: 'is it up' },
      b: { type: 'choice' as const, instructions: 'where', criteria: { x: 'one', y: 'two' } },
      c: { type: 'score' as const, instructions: 'how bad', criteria: ['low', 'medium', 'high', 'critical'] },
    };
    const mapped = mapLayaAnswers(questions, {
      a: { noul: 0.8 },
      b: { choice: 'y', probabilities: { x: 0.1, y: 0.9 }, confidence: 0.9 },
      c: { score: 1.5, probabilities: { '0': 0.1, '1': 0.4, '2': 0.4, '3': 0.1 }, confidence: 0.4 },
    });
    expect(mapped.a).toEqual({ type: 'noul', noul: 0.8 });
    expect(mapped.b).toEqual({ type: 'choice', choice: 'y', confidence: 0.9, probabilities: { x: 0.1, y: 0.9 } });
    // The expected level index is normalised to 0..1 and keyed by the labels.
    expect(mapped.c).toEqual({
      type: 'score',
      score: 0.5,
      confidence: 0.4,
      probabilities: { low: 0.1, medium: 0.4, high: 0.4, critical: 0.1 },
    });
  });

  it('clamps out-of-range probabilities and skips missing answers', () => {
    const mapped = mapLayaAnswers(
      { a: { type: 'noul', instructions: 'x' }, b: { type: 'noul', instructions: 'y' } },
      { a: { noul: 4 } },
    );
    expect(mapped.a).toEqual({ type: 'noul', noul: 1 });
    expect(mapped.b).toBeUndefined();
  });
});

describe('the decision head', () => {
  const noul = (answer: ReturnType<typeof headAnswers>[string]): number =>
    answer.type === 'noul' ? answer.noul : Number.NaN;

  it('reads the head trained for the configured checkpoint', () => {
    const env = tempEnv();
    expect(layaHeadPath({ ...DEFAULT_CONFIG, layaSubfolder: '' }, env))
      .toBe(join(repoRoot, 'calibration', 'laya-head.json'));
    expect(layaHeadPath({ ...DEFAULT_CONFIG, layaSubfolder: 'multilingual' }, env))
      .toBe(join(repoRoot, 'calibration', 'laya-head-multilingual.json'));
    // No head was fitted for this checkpoint, so Laya answers it raw.
    expect(layaHeadPath({ ...DEFAULT_CONFIG, layaSubfolder: 'typed-decisions' }, env)).toBe('');
    expect(layaHeadPath({ ...DEFAULT_CONFIG, layaSubfolder: '', layaHead: false }, env)).toBe('');
  });

  it('writes the head verdict in the policy language', () => {
    const drop = headAnswers({ drop: 0.9, hazard: 0.1, dropThreshold: 0.1, hazardThreshold: 0.84 });
    expect(noul(drop.needs_contents)).toBeLessThan(0.5);
    expect(noul(drop.replaceable)).toBeGreaterThan(0.5);
    expect(noul(drop.agent_directed)).toBeLessThan(0.5);

    const keep = headAnswers({ drop: 0.02, hazard: 0.99, dropThreshold: 0.1, hazardThreshold: 0.84 });
    expect(noul(keep.needs_contents)).toBeGreaterThan(0.5);
    expect(noul(keep.replaceable)).toBeLessThan(0.5);
    // A hazard caps the answers at keep, whatever the drop head wants.
    expect(noul(keep.agent_directed)).toBeGreaterThan(0.9);
    expect(noul(keep.behaviour_change)).toBeGreaterThan(0.9);
  });
});

describe('failing open', () => {
  it('keeps the result when the local model cannot start', async () => {
    const env = tempEnv({
      provider: 'laya',
      layaPython: join(tmpdir(), 'cd-no-such-python-' + process.pid),
      layaWarmTimeoutMs: 1_500,
      minTokens: 10,
      debug: true,
    });
    appendCache(env, 's1', seed, DEFAULT_CONFIG);
    const out = await adapterMain(payload('x'.repeat(4000)), env);
    expect(out).toBe('');
    const log = readFileSync(logPath(env), 'utf8');
    expect(log).toContain('"action":"keep"');
    expect(log).toContain('laya worker did not start');
  });

  it('keeps the result when the worker is missing entirely', async () => {
    const env = tempEnv({ provider: 'laya', layaWarmTimeoutMs: 1_000, minTokens: 10, debug: true });
    appendCache(env, 's1', seed, DEFAULT_CONFIG);
    expect(await adapterMain(payload('y'.repeat(4000)), env)).toBe('');
  });
});

describe('the provider command', () => {
  it('shows the configured provider', async () => {
    const { spawnSync } = await import('node:child_process');
    const env = tempEnv({});
    const result = spawnSync('node', [join(repoRoot, 'dist', 'cli.js'), 'provider'], { env, encoding: 'utf8' });
    expect(result.stdout).toContain('provider:   jev');
    expect(result.stdout).toContain('key:');
  });

  it('switches provider and model with one command', async () => {
    const { spawnSync } = await import('node:child_process');
    const env = tempEnv({});
    const result = spawnSync(
      'node',
      [join(repoRoot, 'dist', 'cli.js'), 'provider', 'set', 'laya', '--subfolder', 'typed-decisions'],
      { env, encoding: 'utf8' },
    );
    expect(result.stdout).toContain('provider: laya');
    const config = JSON.parse(readFileSync(configPath(env), 'utf8'));
    expect(config.provider).toBe('laya');
    expect(config.layaSubfolder).toBe('typed-decisions');
  });

  it('prints the setup steps without installing anything', async () => {
    const { spawnSync } = await import('node:child_process');
    const env = tempEnv({});
    const result = spawnSync('node', [join(repoRoot, 'dist', 'cli.js'), 'setup', '--provider', 'laya'], { env, encoding: 'utf8' });
    expect(result.stdout).toContain('uv venv');
    expect(result.stdout).toContain('--install');
  });
});
