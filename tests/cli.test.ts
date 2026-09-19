import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderBenchmark } from '../src/bench.js';
import { configPath } from '../src/config.js';
import { doctorExitCode, renderDoctor, runDoctor } from '../src/doctor.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const isolatedEnv = (prefix: string): NodeJS.ProcessEnv => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return {
    ...process.env,
    PLUGIN_DATA: dir,
    HOME: dir,
    TYPESAFE_API_KEY: '',
    TYPESAFE_KEY_FILE: join(dir, 'no-key-here'),
  };
};

describe('doctor', () => {
  it('reports a broken config as a hard failure', () => {
    const env = isolatedEnv('cd-doctor-');
    writeFileSync(configPath(env), '{ not json');
    const checks = runDoctor(env);
    expect(checks.find((check) => check.name === 'config')?.status).toBe('fail');
    expect(doctorExitCode(checks)).toBe(1);
    expect(renderDoctor(checks)).toContain('1 fail');
  });

  it('passes on this checkout without a key, with the key as a warning', () => {
    const checks = runDoctor(isolatedEnv('cd-doctor-ok-'));
    expect(checks.find((check) => check.name === 'manifest')?.status).toBe('ok');
    expect(checks.find((check) => check.name === 'mcp')?.status).toBe('ok');
    expect(checks.find((check) => check.name === 'jev key')?.status).toBe('warn');
    expect(doctorExitCode(checks)).toBe(0);
  });
});

describe('benchmark', () => {
  it('renders every latency row and the live note', () => {
    const output = renderBenchmark({
      iterations: 5, resultChars: 1000,
      local: { p50: 1, p95: 2, mean: 1.5 },
      commandHook: { p50: 3, p95: 4, mean: 3.5 },
      mcp: { p50: 5, p95: 6, mean: 5.5 },
      mcpStartupMs: 7, liveMs: null, liveNote: 'excluded, test asker',
    });
    expect(output).toContain('local pipeline');
    expect(output).toContain('mcp tool call');
    expect(output).toContain('mcp startup');
    expect(output).toContain('Jev network latency: excluded');
  });
});

describe('cli surface', () => {
  it('runs doctor and benchmark off the built entry point', () => {
    const env = isolatedEnv('cd-cli-');
    const doctor = spawnSync('node', [join(repoRoot, 'dist', 'cli.js'), 'doctor'], { env, encoding: 'utf8' });
    expect(doctor.stdout).toContain('Context Diet doctor');
    expect(doctor.status).toBe(0);
    const bench = spawnSync('node', [join(repoRoot, 'dist', 'cli.js'), 'benchmark', '3'], {
      env, encoding: 'utf8', timeout: 30000,
    });
    expect(bench.stdout).toContain('local pipeline');
    expect(bench.status).toBe(0);
  });
});

