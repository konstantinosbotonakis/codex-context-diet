import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { configPath } from '../src/config.js';

/**
 * These run the built hooks the way Codex runs them, one process per payload.
 * The unit tests cover main(); these cover the entry point that has to write
 * what main() returns. Requires a build first, which is why CI builds before
 * it tests.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const entry = (name: string) => join(root, 'dist', 'codex', name);

const run = (name: string, payload: unknown, env: Record<string, string>): string =>
  execFileSync('node', [entry(name)], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });

const tempData = (config: unknown = {}): string => {
  const dir = mkdtempSync(join(tmpdir(), 'cd-entry-'));
  writeFileSync(configPath({ PLUGIN_DATA: dir } as NodeJS.ProcessEnv), JSON.stringify(config));
  return dir;
};

const prompt = (text: string) => ({
  hook_event_name: 'UserPromptSubmit',
  session_id: 's1',
  prompt: text,
  cwd: '/tmp',
});

const bigOutput = 'npm test output line 12345\n'.repeat(600);
const dietPayload = {
  hook_event_name: 'PostToolUse',
  session_id: 's1',
  tool_name: 'Bash',
  tool_use_id: 't1',
  tool_input: { command: 'npm test' },
  tool_response: { output: bigOutput },
};

const dietAnswers =
  '{"needs_contents":0.05,"replaceable":0.9,"keep_call":0.9,"agent_directed":0.02,"behaviour_change":0.02}';
const guardAnswers = '{"touches_production":0.95,"irreversible":0.2}';

describe('built entry points', () => {
  it('explains the policy resolution from the CLI', () => {
    const out = execFileSync('node', [join(root, 'dist', 'cli.js'), 'policy'], { encoding: 'utf8' });
    expect(out).toContain('Context Diet policy');
    expect(out).toContain('toolPolicies:');
    expect(out).toContain('resolution at critical pressure:');
  });

  it('subagent hook returns the result contract as JSON', () => {
    const out = run(
      'subagent-main.js',
      { hook_event_name: 'SubagentStart', session_id: 's1', agent_id: 'a1', agent_type: 'explorer' },
      {},
    );
    const parsed = JSON.parse(out) as Record<string, unknown>;
    const hook = parsed.hookSpecificOutput as Record<string, unknown>;
    expect(hook.hookEventName).toBe('SubagentStart');
    expect(String(hook.additionalContext)).toContain('conclusion');
  });
  it('are built', () => {
    expect(existsSync(entry('session-main.js'))).toBe(true);
    expect(existsSync(entry('adapter-main.js'))).toBe(true);
  });

  it('session hook writes the prompt-guard line to stdout', () => {
    const data = tempData({ promptGuard: true });
    const out = run('session-main.js', prompt('Deploy the worker to production'), {
      PLUGIN_DATA: data,
      CONTEXT_DIET_TEST_ANSWERS: guardAnswers,
    });
    const parsed = JSON.parse(out) as Record<string, unknown>;
    const hook = parsed.hookSpecificOutput as Record<string, unknown>;
    expect(hook.hookEventName).toBe('UserPromptSubmit');
    expect(String(hook.additionalContext)).toContain('live system');
  });

  it('session hook writes nothing when the guard is off', () => {
    const data = tempData({});
    expect(
      run('session-main.js', prompt('Deploy the worker to production'), {
        PLUGIN_DATA: data,
        CONTEXT_DIET_TEST_ANSWERS: guardAnswers,
      }),
    ).toBe('');
  });

  it('diet hook stays silent on the first result and replaces the second', () => {
    const data = tempData({ minTokens: 100 });
    const env = { PLUGIN_DATA: data, CONTEXT_DIET_TEST_ANSWERS: dietAnswers };
    expect(run('adapter-main.js', dietPayload, env)).toBe('');
    const parsed = JSON.parse(run('adapter-main.js', dietPayload, env)) as Record<string, unknown>;
    expect(parsed.decision).toBe('block');
    expect(String(parsed.reason)).toContain('Re-run the tool if you need the full output.');
  });

  it('adapter writes nothing for a tool it never diets', () => {
    const data = tempData({ minTokens: 100 });
    expect(run('adapter-main.js', { ...dietPayload, tool_name: 'apply_patch' }, { PLUGIN_DATA: data })).toBe('');
  });
});
