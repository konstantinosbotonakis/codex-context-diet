import { execFile, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configPath, DEFAULT_CONFIG } from '../src/config.js';
import { main as adapterMain } from '../src/codex/adapter.js';
import { main as sessionMain } from '../src/codex/session.js';
import { handleSubagent } from '../src/codex/subagent.js';
import { handleStop } from '../src/codex/qualityGuard.js';
import { logPath } from '../src/codex/log.js';
import { runEvaluation } from '../src/eval.js';
import { layaPaths } from '../src/providers/laya.js';

describe('Laya without a hosted-provider key', () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;
  let server: Server;

  beforeEach(async () => {
    // A local protocol fixture exercises the real Laya transport without loading weights.
    dir = mkdtempSync('/tmp/cd-keyless-');
    env = { PATH: process.env.PATH, HOME: dir, PLUGIN_DATA: dir };
    writeFileSync(configPath(env), JSON.stringify({
      provider: 'laya', layaHead: false, stateSource: 'off', minTokens: 10,
      promptGuard: true, qualityGuard: true, debug: true,
    }));
    const paths = layaPaths(env);
    mkdirSync(paths.dir, { recursive: true });
    server = createServer((socket) => {
      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += chunk.toString();
        if (!buffer.includes('\n')) return;
        const request = JSON.parse(buffer);
        if (request.op === 'ping') {
          socket.end(JSON.stringify({
            model: DEFAULT_CONFIG.layaModel, subfolder: DEFAULT_CONFIG.layaSubfolder,
            head: '', workerMtime: statSync(paths.worker).mtimeMs / 1000,
          }) + '\n');
        } else {
          socket.end(JSON.stringify({
            model: 'laya/protocol-fixture', usage: { input_tokens: 42 },
            answers: Object.fromEntries(Object.keys(request.questions).map((key) => [key, { noul: 0.8 }])),
          }) + '\n');
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(paths.socket, resolve));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  const readEvents = (env: NodeJS.ProcessEnv) =>
    readFileSync(logPath(env), 'utf8').trim().split('\n').map((line) => JSON.parse(line));

  it('judges tool results locally instead of reporting a missing Jev key', async () => {
    const output = await adapterMain(JSON.stringify({
      hook_event_name: 'PostToolUse', session_id: 's1', tool_name: 'Bash', tool_use_id: 't1',
      tool_input: { command: 'npm test' }, tool_response: { output: 'test output\n'.repeat(300) },
    }), env);
    expect(output).not.toContain('API key');
    expect(readEvents(env)).toContainEqual(expect.objectContaining({ kind: 'diet', model: 'laya/protocol-fixture' }));
  });

  it('checks prompts locally without a Jev key', async () => {
    await sessionMain(JSON.stringify({
      hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'Deploy the service to production.',
    }), env);
    expect(readEvents(env)).toContainEqual(expect.objectContaining({ kind: 'prompt_guard', asked: true, inputTokens: 42 }));
  });

  it.each(['subagent', 'quality'] as const)('runs the %s guard locally without a Jev key', async (kind) => {
    const payload = {
      hook_event_name: kind === 'subagent' ? 'SubagentStop' : 'Stop', agent_id: 'a1', turn_id: 't1',
      last_assistant_message: 'I completed the requested change and checked its behavior. '.repeat(8),
    };
    await (kind === 'subagent' ? handleSubagent : handleStop)(payload, env);
    expect(readEvents(env)).toContainEqual(expect.objectContaining({ kind: kind + '_verdict', inputTokens: 42 }));
  });

  it('evaluates the configured local model without a Jev key', async () => {
    const report = await runEvaluation({ live: true, env });
    expect(report.metrics.estimatedCostUsd).toBe(0);
    expect(report.metrics.jevCalls).toBe(112);
  });

  it.each(['eval-prompts', 'eval-guards'])('runs %s against the local provider without a key', async (script) => {
    const { stdout, stderr } = await new Promise<{ stdout: string; stderr: string }>((resolve) => {
      execFile(process.execPath, [join(import.meta.dirname, '..', 'scripts', script + '.mjs'), '--live'], { env },
        (_error, stdout, stderr) => resolve({ stdout, stderr }));
    });
    expect(stderr).not.toContain('no TypeSafe API key');
    expect(stdout).toMatch(/accuracy:|cases/);
  });

  it('serves direct MCP judgements locally without a Jev key', async () => {
    const child = spawn(process.execPath, [join(import.meta.dirname, '..', 'dist', 'mcp-server.js')], { env });
    try {
      const response = new Promise<string>((resolve, reject) => {
        let buffer = '';
        child.on('error', reject);
        child.stdout.on('data', (chunk) => {
          buffer += chunk.toString();
          if (buffer.includes('\n')) resolve(buffer.slice(0, buffer.indexOf('\n')));
        });
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
        name: 'jev_boolean', arguments: { state: 'All tests passed.', question: 'Did the tests pass?' },
      } }) + '\n');
      const result = JSON.parse(await response).result;
      expect(result.isError).not.toBe(true);
      expect(JSON.stringify(result)).toContain('laya/protocol-fixture');
    } finally {
      child.kill();
      await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    }
  });
});
