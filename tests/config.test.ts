import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, configPath, loadConfig, pluginDataDir, resolveConfig } from '../src/config.js';
import { resolveApiKey } from '../src/key.js';

const tempEnv = (): NodeJS.ProcessEnv => {
  const dir = mkdtempSync(join(tmpdir(), 'cd-config-'));
  return { PLUGIN_DATA: dir, HOME: dir } as NodeJS.ProcessEnv;
};

describe('config', () => {
  it('returns the documented defaults for an empty config', () => {
    expect(resolveConfig(undefined)).toEqual(DEFAULT_CONFIG);
    expect(DEFAULT_CONFIG).toMatchObject({
      enabled: true, mode: 'diet', dryRun: false, stateSource: 'cache',
      minTokens: 2000, keepThreshold: 0.5, dropThreshold: 0.25, truncateHeadChars: 300,
      maxStateTokens: 25000, stateResultCapChars: 4000, requestTimeoutMs: 2500,
      injectionGuard: true, model: 'jev-latest', neverDietTools: [],
      cacheMaxEntries: 40, cacheMaxBytes: 262144, debug: false,
    });
  });

  it('falls back per field instead of trusting nonsense', () => {
    const config = resolveConfig({
      minTokens: Number.NaN, keepThreshold: 'x', mode: 'sideways', stateSource: 7,
      neverDietTools: 'Bash', cacheMaxEntries: -3, enabled: 'yes',
    });
    expect(config).toMatchObject({
      minTokens: 2000, keepThreshold: 0.5, dropThreshold: 0.25, mode: 'diet', stateSource: 'cache',
      neverDietTools: [], cacheMaxEntries: 40, enabled: true, truncateHeadChars: 300,
    });
  });

  it('merges a valid partial config', () => {
    const config = resolveConfig({ minTokens: 10, neverDietTools: ['Bash', 5] });
    expect(config.minTokens).toBe(10);
    expect(config.neverDietTools).toEqual(['Bash']);
  });

  it('accepts only the two implemented state sources', () => {
    expect(resolveConfig({ stateSource: 'off' }).stateSource).toBe('off');
    expect(resolveConfig({ stateSource: 'transcript' }).stateSource).toBe('cache');
    expect(resolveConfig({ stateSource: 7 }).stateSource).toBe('cache');
  });

  it('loads a valid file and survives a missing or invalid one', () => {
    const env = tempEnv();
    expect(loadConfig(env)).toEqual(DEFAULT_CONFIG);
    writeFileSync(configPath(env), '{ not json');
    expect(loadConfig(env)).toEqual(DEFAULT_CONFIG);
    writeFileSync(configPath(env), JSON.stringify({ minTokens: 5 }));
    expect(loadConfig(env).minTokens).toBe(5);
    expect(pluginDataDir(env)).toBe(env.PLUGIN_DATA);
  });
});

describe('key resolution', () => {
  const config = { ...DEFAULT_CONFIG, apiKey: 'from-config' };

  it('prefers env, then the key file, then config, then none', () => {
    const env = tempEnv();
    expect(resolveApiKey(DEFAULT_CONFIG, env)).toEqual({ key: null, source: 'none' });
    writeFileSync(join(env.HOME as string, '.typesafe_key'), 'from-file\n');
    expect(resolveApiKey(DEFAULT_CONFIG, env)).toEqual({ key: 'from-file', source: 'file' });
    expect(resolveApiKey(DEFAULT_CONFIG, { ...env, TYPESAFE_API_KEY: 'from-env' })).toEqual({
      key: 'from-env', source: 'env',
    });
    expect(resolveApiKey(DEFAULT_CONFIG, { ...env, TYPESAFE_API_KEY: '   ' })).toEqual({
      key: 'from-file', source: 'file',
    });
    expect(resolveApiKey(config, { ...env, HOME: join(env.PLUGIN_DATA as string, 'nowhere') })).toEqual({
      key: 'from-config', source: 'config',
    });
  });

  it('never puts the key in the source field', () => {
    const env = { ...tempEnv(), TYPESAFE_API_KEY: 'secret-value' } as NodeJS.ProcessEnv;
    const resolved = resolveApiKey(DEFAULT_CONFIG, env);
    expect(resolved.source).toBe('env');
    expect(JSON.stringify({ source: resolved.source })).not.toContain('secret-value');
  });
});
