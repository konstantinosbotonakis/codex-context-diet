import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { configPath, DEFAULT_CONFIG, type DietConfig } from '../src/config.js';
import { main as adapterMain } from '../src/codex/adapter.js';
import { logPath } from '../src/codex/log.js';
import { PRESSURE_THRESHOLDS, pressureStage, retainedTokens } from '../src/pressure.js';
import { commandCategory, outputClassOf, resolveEffectivePolicy, toolFamily } from '../src/policy.js';

const config = (over: Partial<DietConfig> = {}): DietConfig => ({ ...DEFAULT_CONFIG, ...over });

const context = (over: Partial<Parameters<typeof resolveEffectivePolicy>[1]> = {}) => ({
  toolName: 'Bash', inputLine: 'npm test', outputClass: '', pressure: 'low' as const, ...over,
});

const tempEnv = (raw: Record<string, unknown>): NodeJS.ProcessEnv => {
  const dir = mkdtempSync(join(tmpdir(), 'cd-policy-'));
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

describe('classification', () => {
  it('names command categories and tool families', () => {
    expect(commandCategory('npm test')).toBe('test');
    expect(commandCategory('npx vitest run')).toBe('test');
    expect(commandCategory('npm run build')).toBe('build');
    expect(commandCategory('git status --short')).toBe('git');
    expect(commandCategory('npm install')).toBe('install');
    expect(commandCategory('ls -la')).toBe('other');
    expect(toolFamily('Bash')).toBe('bash');
    expect(toolFamily('Read')).toBe('read');
    expect(toolFamily('mcp__fs__read')).toBe('mcp');
    expect(toolFamily('WebSearch')).toBe('other');
  });

  it('classifies output from a bounded sample', () => {
    expect(outputClassOf('FAIL tests/a.test.ts\nAssertionError: expected 1 to be 2', 1000)).toBe('test-log');
    expect(outputClassOf('plain words only', 1000)).toBe('generic');
  });
});

describe('policy resolution', () => {
  it('uses the base values when nothing matches', () => {
    expect(resolveEffectivePolicy(config(), context())).toMatchObject({
      minTokens: 2000, keepThreshold: 0.5, dropThreshold: 0.25, source: 'base', pressure: 'low',
    });
  });

  it('lowers the gate under pressure and never raises it', () => {
    expect(resolveEffectivePolicy(config(), context({ pressure: 'high' })).minTokens).toBe(1000);
    expect(resolveEffectivePolicy(config(), context({ pressure: 'critical' })).minTokens).toBe(750);
    expect(resolveEffectivePolicy(config({ minTokens: 8000 }), context()).minTokens).toBe(8000);
    expect(resolveEffectivePolicy(config({ minTokens: 8000 }), context({ pressure: 'critical' })).minTokens).toBe(750);
    expect(resolveEffectivePolicy(config({ contextPressure: false }), context({ pressure: 'critical' })).minTokens).toBe(2000);
  });

  it('lets the last matching policy win as a whole entry', () => {
    const policies = [
      { match: 'family:bash', dropThreshold: 0.3 },
      { match: 'Bash:test', minTokens: 500, dropThreshold: 0.4 },
      { match: 'Bash', minTokens: 9000 },
    ];
    const resolved = resolveEffectivePolicy(config({ toolPolicies: policies }), context());
    expect(resolved).toMatchObject({ minTokens: 9000, dropThreshold: 0.25, source: 'Bash' });
    const read = resolveEffectivePolicy(config({ toolPolicies: policies }), context({ toolName: 'Read', inputLine: '/repo/a.ts' }));
    expect(read.minTokens).toBe(2000);
    expect(read.source).toBe('base');
  });

  it('matches output classes when a policy asks for one', () => {
    const policies = [{ match: 'output:test-log', dropThreshold: 0.4 }];
    const resolved = resolveEffectivePolicy(
      config({ toolPolicies: policies }),
      context({ outputClass: 'test-log' }),
    );
    expect(resolved.source).toBe('output:test-log');
    expect(resolved.dropThreshold).toBe(0.4);
  });
});

describe('context pressure', () => {
  it('sums what the session kept and stages it', () => {
    const cache = [
      { tool_use_id: 'a', tool_name: 'Bash', at: '', input: '', head: '', tail: '', chars: 40_000, decision: 'keep', goal_index: 0 },
      { tool_use_id: 'b', tool_name: 'Bash', at: '', input: '', head: '', tail: '', chars: 40_000, keptChars: 400, decision: 'drop_result', goal_index: 0 },
    ] as never;
    expect(retainedTokens(cache)).toBe(Math.round((40_000 + 400) / 4));
    expect(pressureStage(0)).toBe('low');
    expect(pressureStage(PRESSURE_THRESHOLDS.moderate)).toBe('moderate');
    expect(pressureStage(PRESSURE_THRESHOLDS.high)).toBe('high');
    expect(pressureStage(PRESSURE_THRESHOLDS.critical + 1)).toBe('critical');
  });
});

describe('policies through the hook', () => {
  it('drops a small test result that a policy lowered the gate for', async () => {
    const env = tempEnv({ debug: true, minTokens: 4000, toolPolicies: [{ match: 'Bash:test', minTokens: 10 }] });
    env.CONTEXT_DIET_TEST_ANSWERS = dropAnswers;
    await adapterMain(payload('t1', 'x'.repeat(400)), env);
    const second = JSON.parse(await adapterMain(payload('t2', 'y'.repeat(400)), env)) as Record<string, unknown>;
    expect(second.decision).toBe('block');
    const log = readFileSync(logPath(env), 'utf8');
    expect(log).toContain('"policy":"Bash:test"');
    expect(log).toContain('"minTokens":10');
  });

  it('leaves the same result alone without the policy', async () => {
    const env = tempEnv({ debug: true, minTokens: 4000 });
    env.CONTEXT_DIET_TEST_ANSWERS = dropAnswers;
    await adapterMain(payload('t1', 'x'.repeat(400)), env);
    expect(await adapterMain(payload('t2', 'y'.repeat(400)), env)).toBe('');
    // Below the floor nothing is judged and nothing is logged at all.
    expect(existsSync(logPath(env))).toBe(false);
  });
});
