#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { countSessions } from './cache.js';
import { configPath, loadConfig, pluginDataDir, saveConfig } from './config.js';
import { JEV_REASON_VALUES } from './codex/diet.js';
import { keyFilePath, resolveApiKey } from './key.js';
import { readUsageInput, renderUsage, summarizeUsage, WINDOWS } from './stats.js';
import { PRESSURE_THRESHOLDS, type PressureStage } from './pressure.js';
import { resolveEffectivePolicy } from './policy.js';
import { renderEvalReport, runEvaluation } from './eval.js';
import { doctorExitCode, renderDoctor, runDoctor } from './doctor.js';
import { renderBenchmark, runBenchmark } from './bench.js';
import { fakeAsker, throwingAsker, verifyCompaction } from './verify.js';
import { layaHeadPath, layaPaths, layaStatus, resolveLayaPython, warmLaya } from './providers/laya.js';
import { createAsker } from './codex/transport.js';

const USAGE = [
  'context-diet <command>',
  '',
  '  status   show configuration, key source and data directory (offline)',
  '  stats    usage totals for today, 7 days and 30 days (offline)',
  '  policy   the size gate, thresholds and pressure scaling per tool (offline)',
  '  eval     run the offline decision corpus, and --live to ask real Jev',
  '  benchmark measure local pipeline, command-hook and MCP latency (offline)',
  '  provider  show or switch the decision model, and warm a local one',
  '  setup     print the steps for a provider, and --install to run them',
  '  doctor   check the install, key, storage, hooks and MCP runtime (offline)',
  '  verify   run the offline verification harness (no network)',
  '  test     send one real request to TypeSafe/Jev (needs a key)',
  '',
].join('\n');

async function status(): Promise<number> {
  const env = process.env;
  const config = loadConfig(env);
  const { key, source } = resolveApiKey(config, env);
  process.stdout.write(
    [
      'config:   ' + configPath(env),
      'data:     ' + pluginDataDir(env),
      'enabled:  ' + config.enabled,
      'mode:     ' + config.mode + (config.dryRun ? ' (dryRun)' : ''),
      'state:    ' + config.stateSource,
      'model:    ' + config.model,
      'key:      ' + source + (key === null ? ' (not configured)' : ''),
      'key file: ' + keyFilePath(env),
      'sessions: ' + countSessions(env),
    ].join('\n') + '\n',
  );
  return 0;
}

async function verify(): Promise<number> {
  const good = await verifyCompaction({
    asker: fakeAsker({ keep_result: 0.1, keep_call: 0.9, injection: 0.05 }),
  });
  const broken = await verifyCompaction({ asker: throwingAsker('verify: a broken asker must fail closed') });
  const failed = broken.checks.filter((check) => !check.ok).map((check) => check.name).join(',');
  const pass = good.ok && !broken.ok && failed === 'asker-contract,decide-call';
  process.stdout.write(
    [
      ...good.checks.map((check) => (check.ok ? '  ok   ' : '  FAIL ') + check.name + ': ' + check.detail),
      '  --',
      '  good asker:   ok=' + good.ok + ', reduction=' + Math.round(good.stats.reduction * 100) + '%',
      '  broken asker: ok=' + broken.ok + ' (expected false), failed=' + (failed || 'none'),
      pass ? 'verify: pass' : 'verify: fail',
    ].join('\n') + '\n',
  );
  return pass ? 0 : 1;
}

async function live(): Promise<number> {
  const env = process.env;
  const config = loadConfig(env);
  const { key, source } = resolveApiKey(config, env);
  if (config.provider !== 'laya' && key === null) {
    process.stdout.write(
      'no API key. Checked TYPESAFE_API_KEY, ' + keyFilePath(env) + ', and the apiKey field in ' +
        configPath(env) + '.\n',
    );
    return 1;
  }
  const started = Date.now();
  try {
    if (config.provider === 'laya') {
      // A cold checkpoint load is far longer than one answer, so this
      // diagnostic warms the daemon first and then measures a real answer.
      const reply = await warmLaya(config, env);
      process.stdout.write('laya: checkpoint ready (' + (reply.model ?? config.layaModel) +
        ' on ' + (reply.device ?? 'auto') + ')\n');
    }
    const asker = createAsker(config, key ?? 'test-key', env);
    const response = await asker.ask(
      { ping: 'ok' },
      {
        reachable: { type: 'noul', instructions: 'This model is reachable and answering questions' },
        sane: { type: 'noul', instructions: 'This request is well formed and can be answered' },
      },
    );
    process.stdout.write(
      [
        'provider:   ' + config.provider,
        'key source: ' + (config.provider === 'laya' ? 'not needed' : source),
        'model:      ' + (response.model ?? config.model),
        'latency:    ' + (Date.now() - started) + ' ms',
        'answers:    ' + JSON.stringify(response.answers),
        'usage:      ' + JSON.stringify(response.usage ?? {}),
      ].join('\n') + '\n',
    );
    return 0;
  } catch (error) {
    process.stdout.write(
      'live request failed: ' + (error instanceof Error ? error.message : String(error)) + '\n',
    );
    return 1;
  }
}

async function stats(): Promise<number> {
  const all = process.argv.includes('--all');
  const asJson = process.argv.includes('--json');
  const input = readUsageInput(process.env, { all });
  const report = summarizeUsage(input, JEV_REASON_VALUES, WINDOWS, input.pricePerMillionInputTokens);
  if (asJson) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return 0;
  }
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  process.stdout.write(renderUsage(report, { timeZone, stores: input.stores }) + '\n');
  return 0;
}

/** Shows which size gate and thresholds each tool would get, and why. */
async function policyReport(): Promise<number> {
  const config = loadConfig(process.env);
  const floor = (value: number): number => (value > 0 ? value : config.minTokens);
  const lines: string[] = [
    'Context Diet policy',
    '',
    'base:            minTokens ' + config.minTokens + ', keep ' + config.keepThreshold + ', drop ' + config.dropThreshold,
    'contextPressure: ' + (config.contextPressure ? 'on' : 'off'),
    '  floors:        low ' + floor(config.pressureLowTokens) +
      ', moderate ' + floor(config.pressureModerateTokens) +
      ', high ' + floor(config.pressureHighTokens) +
      ', critical ' + floor(config.pressureCriticalTokens),
    '  stage marks:   moderate >= ' + PRESSURE_THRESHOLDS.moderate +
      ', high >= ' + PRESSURE_THRESHOLDS.high +
      ', critical >= ' + PRESSURE_THRESHOLDS.critical + ' retained tokens',
    'toolPolicies:    ' + config.toolPolicies.length,
  ];
  for (const item of config.toolPolicies) {
    const overrides = [
      item.minTokens !== undefined ? 'minTokens ' + item.minTokens : null,
      item.keepThreshold !== undefined ? 'keep ' + item.keepThreshold : null,
      item.dropThreshold !== undefined ? 'drop ' + item.dropThreshold : null,
    ].filter((value): value is string => value !== null);
    lines.push('  ' + item.match + ' -> ' + (overrides.length > 0 ? overrides.join(', ') : 'no overrides'));
  }
  const examples = [
    { toolName: 'Bash', inputLine: 'npm test' },
    { toolName: 'Bash', inputLine: 'npm run build' },
    { toolName: 'Bash', inputLine: 'git status' },
    { toolName: 'Read', inputLine: '/repo/src/app.ts' },
  ];
  for (const stage of ['low', 'high', 'critical'] as PressureStage[]) {
    lines.push('', 'resolution at ' + stage + ' pressure:');
    for (const example of examples) {
      const resolved = resolveEffectivePolicy(config, {
        toolName: example.toolName,
        inputLine: example.inputLine,
        outputClass: '',
        pressure: stage,
      });
      lines.push(
        '  ' + example.toolName + ' ' + example.inputLine + ' -> minTokens ' + resolved.minTokens +
          ', keep ' + resolved.keepThreshold + ', drop ' + resolved.dropThreshold + '  [' + resolved.source + ']',
      );
    }
  }
  process.stdout.write(lines.join('\n') + '\n');
  return 0;
}

/** The decision corpus. Offline by default; `--live` asks the real model. */
async function evalCommand(): Promise<number> {
  const live = process.argv.includes('--live');
  try {
    const report = await runEvaluation({ live });
    process.stdout.write(renderEvalReport(report) + '\n');
    if (live) return 0;
    return report.metrics.falseDrops > 0 ? 1 : 0;
  } catch (error) {
    process.stderr.write('eval failed: ' + (error instanceof Error ? error.message : String(error)) + '\n');
    return 1;
  }
}

const command = process.argv[2] ?? '';

/** Local latency measurement. `--live` is the only part that touches the network. */
async function benchmark(): Promise<number> {
  const iterations = Number(process.argv.find((value) => /^[0-9]+$/.test(value)) ?? 20);
  const report = await runBenchmark({ iterations, live: process.argv.includes('--live') });
  process.stdout.write(renderBenchmark(report) + '\n');
  return 0;
}

/** Local health check. Exit 1 when a probe reports a hard failure. */
function flagValue(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

/** Which model answers the questions, and the state of a local one. */
async function providerCommand(): Promise<number> {
  const env = process.env;
  const config = loadConfig(env);
  const action = process.argv[3] ?? 'status';

  if (action === 'set') {
    const target = process.argv[4];
    if (target !== 'jev' && target !== 'laya') {
      process.stdout.write('usage: context-diet provider set <jev|laya> [--subfolder name] [--model repo]\n');
      return 2;
    }
    const subfolder = flagValue('--subfolder');
    const model = flagValue('--model');
    const python = flagValue('--python');
    saveConfig(env, {
      provider: target,
      ...(subfolder !== null ? { layaSubfolder: subfolder } : {}),
      ...(model !== null ? { layaModel: model } : {}),
      ...(python !== null ? { layaPython: python } : {}),
    });
    process.stdout.write('provider: ' + target + '\n');
    if (target === 'laya') process.stdout.write('run `context-diet provider warm` once to load the checkpoint\n');
    return 0;
  }

  if (action === 'warm') {
    const started = Date.now();
    try {
      const reply = await warmLaya(config, env);
      process.stdout.write(
        'laya: loaded ' + (reply.model ?? config.layaModel) + ' on ' + (reply.device ?? 'auto') +
          ' in ' + ((Date.now() - started) / 1000).toFixed(1) + ' s\n',
      );
      return 0;
    } catch (error) {
      process.stdout.write('laya: ' + (error instanceof Error ? error.message : String(error)) + '\n');
      return 1;
    }
  }

  const paths = layaPaths(env);
  const python = resolveLayaPython(config, env);
  const lines = [
    'provider:   ' + config.provider,
    'model:      ' + (config.provider === 'laya' ? config.layaModel : config.model),
  ];
  if (config.provider === 'laya') {
    lines.push(
      'subfolder:  ' + (config.layaSubfolder.length > 0 ? config.layaSubfolder : '(repo root)'),
      'python:     ' + python + (python === paths.venvPython ? ' (managed venv)' : ''),
      'worker:     ' + paths.worker,
      'socket:     ' + paths.socket,
    );
    const head = layaHeadPath(config, env);
    lines.push('head:       ' + (head.length > 0 ? head : 'none for this checkpoint; Laya answers raw'));
    const status = await layaStatus(config, env);
    lines.push(
      'daemon:     ' + (status === null
        ? 'not running (it starts on the first call)'
        : 'running, ' + (status.loaded === true ? 'model loaded' : 'model not loaded yet') +
          (status.device ? ', device ' + status.device : '') + (status.laya ? ', laya ' + status.laya : '')),
    );
  }
  const { key, source } = resolveApiKey(config, env);
  lines.push('key:        ' + (config.provider === 'laya' ? 'not needed for a local model' : source + (key === null ? ' (not configured)' : '')));
  process.stdout.write(lines.join('\n') + '\n');
  return 0;
}

/** The steps for one provider, and optionally the local install for Laya. */
async function setupCommand(): Promise<number> {
  const env = process.env;
  const config = loadConfig(env);
  const target = flagValue('--provider') ?? 'laya';
  const install = process.argv.includes('--install');
  const paths = layaPaths(env);
  const python = resolveLayaPython(config, env);
  if (target === 'jev') {
    process.stdout.write(
      [
        'TypeSafe Jev is the default provider and needs a key:',
        '  1. write the key:  printf %s "$YOUR_KEY" > ~/.typesafe_key && chmod 600 ~/.typesafe_key',
        '  2. check it:       node dist/cli.js test',
        '  3. keep the model: node dist/cli.js provider set jev',
      ].join('\n') + '\n',
    );
    return 0;
  }
  const steps = [
    'uv venv --python 3.13 ' + join(paths.dir, 'venv'),
    'uv pip install --python ' + paths.venvPython + ' laya',
    'node dist/cli.js provider set laya --subfolder multilingual',
    'node dist/cli.js provider warm',
  ];
  process.stdout.write(['A local Laya checkpoint needs Python 3.9 to 3.13 (torch has no 3.14 wheel yet):', ...steps.map((step, index) => '  ' + (index + 1) + '. ' + step), ''].join('\n'));
  if (!install) {
    process.stdout.write('run again with --install to execute steps 1 and 2 now\n');
    return 0;
  }
  try {
    mkdirSync(paths.dir, { recursive: true });
    execFileSync('uv', ['venv', '--python', '3.13', join(paths.dir, 'venv')], { stdio: 'inherit' });
    execFileSync('uv', ['pip', 'install', '--python', paths.venvPython, 'laya'], { stdio: 'inherit' });
  } catch (error) {
    process.stdout.write('install failed: ' + (error instanceof Error ? error.message : String(error)) + '\n');
    process.stdout.write('python: ' + python + '\n');
    return 1;
  }
  saveConfig(env, { provider: 'laya' });
  process.stdout.write('provider set to laya; run `context-diet provider warm` to load the checkpoint\n');
  return 0;
}

async function doctor(): Promise<number> {
  const checks = runDoctor(process.env);
  process.stdout.write(renderDoctor(checks) + '\n');
  return doctorExitCode(checks);
}

if (command === 'status') process.exitCode = await status();
else if (command === 'stats') process.exitCode = await stats();
else if (command === 'policy') process.exitCode = await policyReport();
else if (command === 'eval') process.exitCode = await evalCommand();
else if (command === 'benchmark') process.exitCode = await benchmark();
else if (command === 'provider') process.exitCode = await providerCommand();
else if (command === 'setup') process.exitCode = await setupCommand();
else if (command === 'doctor') process.exitCode = await doctor();
else if (command === 'verify') process.exitCode = await verify();
else if (command === 'test') process.exitCode = await live();
else process.stdout.write(USAGE);
