import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cachePath } from '../src/cache.js';
import { configPath, DEFAULT_CONFIG, type DietConfig } from '../src/config.js';
import { main as adapterMain } from '../src/codex/adapter.js';
import { runDiet, type DietInput } from '../src/codex/diet.js';
import { appendEvent, logPath } from '../src/codex/log.js';
import { assessPrompt } from '../src/codex/promptGuard.js';
import { isNeverSendInput, redactText } from '../src/privacy.js';

const SENTINEL = {
  openai: 'sk-live-abcdefghijklmnopqrstuvwx',
  github: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
  jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk',
  aws: 'AKIAIOSFODNN7EXAMPLE',
  db: 'postgres://user:hunter2secret@db.example.com/app',
  pem: '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA7Z\n-----END RSA PRIVATE KEY-----',
};

const SECRETS = Object.values(SENTINEL);
const SAMPLE = [
  'OPENAI_API_KEY=' + SENTINEL.openai,
  'token: ' + SENTINEL.github,
  'authorization Bearer ' + SENTINEL.jwt,
  'aws ' + SENTINEL.aws,
  'db ' + SENTINEL.db,
  SENTINEL.pem,
].join('\n');

const tempEnv = (config: Record<string, unknown> = {}): NodeJS.ProcessEnv => {
  const dir = mkdtempSync(join(tmpdir(), 'cd-privacy-'));
  const env = { PLUGIN_DATA: dir } as NodeJS.ProcessEnv;
  writeFileSync(configPath(env), JSON.stringify(config));
  return env;
};

const strict = (over: Partial<DietConfig> = {}): DietConfig => ({ ...DEFAULT_CONFIG, ...over });
const containsSecret = (text: string): boolean => SECRETS.some((secret) => text.includes(secret));

describe('redaction rules', () => {
  it('replaces every seeded shape with a placeholder', () => {
    const result = redactText(SAMPLE, 'strict');
    expect(result.findings).toBeGreaterThanOrEqual(6);
    expect(result.text).toContain('<REDACTED_API_KEY>');
    expect(result.text).toContain('<REDACTED_JWT>');
    expect(result.text).toContain('<REDACTED_GITHUB_TOKEN>');
    expect(result.text).toContain('<REDACTED_AWS_KEY>');
    expect(result.text).toContain('<REDACTED_CONNECTION_STRING>');
    expect(result.text).toContain('<REDACTED_PRIVATE_KEY>');
    expect(containsSecret(result.text)).toBe(false);
  });

  it('leaves ordinary output alone', () => {
    const text = 'npm test passed 42 tests in 3.2s';
    expect(redactText(text, 'strict')).toEqual({ text, findings: 0 });
  });

  it('changes nothing when the mode is off', () => {
    expect(redactText(SAMPLE, 'off')).toEqual({ text: SAMPLE, findings: 0 });
  });

  it('keeps excluded paths and excluded tools local', () => {
    const config = strict();
    expect(isNeverSendInput('Read', '/repo/.env', config)).toBe(true);
    expect(isNeverSendInput('Bash', 'cat .env', config)).toBe(true);
    expect(isNeverSendInput('Bash', 'cat server.key', config)).toBe(true);
    expect(isNeverSendInput('Bash', 'cat certs/service.pem', config)).toBe(true);
    expect(isNeverSendInput('Bash', 'npm test', config)).toBe(false);
    expect(isNeverSendInput('Read', '/repo/README.md', config)).toBe(false);
    expect(isNeverSendInput('Read', '/repo/.env', strict({ privacyMode: 'standard' }))).toBe(false);
    expect(isNeverSendInput('Read', '/repo/README.md', strict({ neverSendTools: ['Read'] }))).toBe(true);
    expect(isNeverSendInput('Read', '/repo/.env', strict({ privacyMode: 'off' }))).toBe(false);
  });
});

describe('the privacy boundary in the hooks', () => {
  it('never puts a secret in the state sent to Jev', async () => {
    let seen = '';
    const asker = {
      async ask(state: unknown, questions: Record<string, unknown>) {
        seen = JSON.stringify(state);
        return {
          answers: Object.fromEntries(
            Object.keys(questions).map((key) => [key, { type: 'noul' as const, noul: 0.5 }]),
          ),
        };
      },
    };
    const input: DietInput = {
      toolName: 'Bash',
      toolUseId: 't1',
      inputLine: 'curl -H "Authorization: Bearer ' + SENTINEL.jwt + '" https://api.example.com',
      resultText: SAMPLE.repeat(20),
      isError: false,
      goalIndex: 0,
    };
    await runDiet({
      input,
      config: strict({ minTokens: 10 }),
      cache: [],
      asker,
      goal: 'check the deploy',
      firstResult: false,
    } as never);
    expect(seen.length).toBeGreaterThan(0);
    expect(containsSecret(seen)).toBe(false);
  });

  it('never puts a secret in the prompt guard state', async () => {
    let seen = '';
    const asker = {
      async ask(state: unknown, questions: Record<string, unknown>) {
        seen = JSON.stringify(state);
        return {
          answers: Object.fromEntries(
            Object.keys(questions).map((key) => [key, { type: 'noul' as const, noul: 0.1 }]),
          ),
        };
      },
    };
    await assessPrompt(
      { cwd: '/tmp', recent: ['export OPENAI_API_KEY=' + SENTINEL.openai], prompt: 'deploy with ' + SENTINEL.jwt },
      asker as never,
      strict(),
    );
    expect(seen.length).toBeGreaterThan(0);
    expect(containsSecret(seen)).toBe(false);
  });

  it('keeps secrets out of the cache and the debug log', async () => {
    const env = tempEnv({ debug: true, minTokens: 10 });
    const payload = JSON.stringify({
      hook_event_name: 'PostToolUse',
      session_id: 's1',
      tool_name: 'Bash',
      tool_use_id: 't1',
      tool_input: { command: 'curl -H "Authorization: Bearer ' + SENTINEL.jwt + '" https://api.example.com' },
      tool_response: { output: SAMPLE.repeat(30) },
    });
    env.CONTEXT_DIET_TEST_ANSWERS = JSON.stringify({
      needs_contents: 0.05, replaceable: 0.9, keep_call: 0.9, agent_directed: 0.02, behaviour_change: 0.02,
    });
    await adapterMain(payload, env);
    await adapterMain(payload, env);
    expect(containsSecret(readFileSync(cachePath(env, 's1'), 'utf8'))).toBe(false);
    expect(containsSecret(readFileSync(logPath(env), 'utf8'))).toBe(false);
  });

  it('redacts any field a future log event might carry', () => {
    const env = tempEnv({ debug: true });
    mkdirSync(join(env.PLUGIN_DATA as string, 'log'), { recursive: true });
    appendEvent(env, strict({ debug: true }), { kind: 'test', note: 'key ' + SENTINEL.openai });
    const line = readFileSync(logPath(env), 'utf8');
    expect(line).toContain('<REDACTED_API_KEY>');
    expect(containsSecret(line)).toBe(false);
  });

  it('keeps an excluded path out of the cache and the log entirely', async () => {
    const env = tempEnv({ debug: true, minTokens: 10 });
    const payload = JSON.stringify({
      hook_event_name: 'PostToolUse',
      session_id: 's2',
      tool_name: 'Read',
      tool_use_id: 't1',
      tool_input: { file_path: '/repo/.env' },
      tool_response: { output: SAMPLE.repeat(30) },
    });
    env.CONTEXT_DIET_TEST_ANSWERS = JSON.stringify({ needs_contents: 0.9, replaceable: 0, keep_call: 0.5 });
    const out = await adapterMain(payload, env);
    expect(out).toBe('');
    expect(readFileSync(logPath(env), 'utf8')).toContain('never_send');
    expect(containsSecret(readFileSync(logPath(env), 'utf8'))).toBe(false);
  });
});

