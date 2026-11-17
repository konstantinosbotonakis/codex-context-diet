import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { checkThreadExecution, summarizeHookTrust } from '../src/doctor-host.js';
import { runDoctor } from '../src/doctor.js';

const dirs: string[] = [];
function temp(): string {
  const path = mkdtempSync(join(tmpdir(), 'cd-doctor-host-'));
  dirs.push(path);
  return path;
}
afterEach(() => { for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true }); });

const trusted = { pluginId: 'codex-context-diet@context-diet', trustStatus: 'trusted', enabled: true };
it('counts only this plugin and flags enabled hooks requiring approval', () => {
  const report = (hooks: object[]) => summarizeHookTrust({ data: [{ hooks }] });
  expect(report([trusted, { ...trusted, pluginId: 'other', trustStatus: 'modified' }])).toMatchObject({ status: 'ok', detail: expect.stringContaining('1/1 trusted') });
  expect(report([trusted, { ...trusted, trustStatus: 'modified' }])).toMatchObject({ status: 'fail', detail: expect.stringContaining('1/2 trusted') });
  expect(report([{ ...trusted, enabled: false }]).status).toBe('warn');
  expect(report([]).status).toBe('warn');
  expect(summarizeHookTrust(undefined).status).toBe('warn');
});

function event(threadId: string, status: string) {
  const run = { source: 'plugin', sourcePath: '/cache/context-diet/codex-context-diet/0.8.7/hooks/hooks.json',
    eventName: 'postToolUse', status, entries: status === 'failed' ? [{ kind: 'error', text: 'hook approval required' }] : [] };
  return '[2026-11-17T19:05:00Z] NTIVE: ' + JSON.stringify({ event: { direction: 'incoming', payload: {
    method: 'hook/completed', params: { threadId, run },
  } } }) + '\n';
}
it('reports the latest failure and an earlier success across rotation, excluding other threads', () => {
  const home = temp();
  const env = { T3CODE_HOME: home, T3CODE_THREAD_ID: 'mcp:launch:test', CODEX_THREAD_ID: 'native' };
  const dir = join(home, 'userdata/logs/provider');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'events.mcp-launch-test.log');
  expect(checkThreadExecution({ HOME: home })).toBeUndefined();
  expect(checkThreadExecution(env)?.status).toBe('warn');
  writeFileSync(file + '.1', event('native', 'completed'));
  writeFileSync(file, event('native', 'failed') + event('other', 'completed') + '{partial');
  expect(checkThreadExecution(env)).toMatchObject({ status: 'fail', detail: expect.stringMatching(/failed \(approval required\).*Last success: .*completed/) });
  writeFileSync(file, event('native', 'completed'));
  expect(checkThreadExecution(env)?.status).toBe('ok');
});

it('prefers explicit data and otherwise uses an existing Codex plugin directory', () => {
  const home = temp();
  const installed = join(home, 'codex/plugins/data/codex-context-diet-context-diet');
  const env = { HOME: home, CODEX_HOME: join(home, 'codex'), PATH: process.env.PATH };
  const directory = (overrides: NodeJS.ProcessEnv) => runDoctor({ ...env, ...overrides }).find(check => check.name === 'data directory')?.detail;
  expect(directory({})).toContain('standalone fallback');
  mkdirSync(installed, { recursive: true });
  expect(directory({})).toContain(installed + ' (Codex plugin data');
  expect(directory({ PLUGIN_DATA: home })).toContain(home + ' (PLUGIN_DATA');
  expect(directory({ CLAUDE_PLUGIN_DATA: home })).toContain(home + ' (CLAUDE_PLUGIN_DATA');
});
