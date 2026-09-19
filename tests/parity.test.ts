import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { appendRecovery } from '../src/cache.js';
import { configPath } from '../src/config.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const serverPath = join(repoRoot, 'dist', 'mcp-server.js');

const children: ChildProcessWithoutNullStreams[] = [];
afterEach(() => {
  while (children.length > 0) children.pop()?.kill();
});

const tempEnv = (config: Record<string, unknown> = {}): NodeJS.ProcessEnv => {
  const dir = mkdtempSync(join(tmpdir(), 'cd-parity-'));
  // PATH has to survive: the tests spawn node for the command transport.
  const env = { ...process.env, PLUGIN_DATA: dir } as NodeJS.ProcessEnv;
  writeFileSync(configPath(env), JSON.stringify(config));
  return env;
};

/** Event to target map for each transport, read straight from the hook files. */
const hookTargets = (file: string): Record<string, string[]> => {
  const hooks = JSON.parse(readFileSync(join(repoRoot, 'hooks', file), 'utf8')).hooks as Record<
    string,
    { hooks: { type: string; tool?: string; command?: string }[] }[]
  >;
  const out: Record<string, string[]> = {};
  for (const [event, entries] of Object.entries(hooks)) {
    out[event] = entries.flatMap((entry) =>
      entry.hooks.map((hook) => {
        if (hook.type === 'mcp_tool') return String(hook.tool);
        const match = /dist\/codex\/([a-z-]+\.js)/.exec(String(hook.command ?? ''));
        return match ? match[1] : String(hook.command ?? '');
      }),
    );
  }
  return out;
};

const EXPECTED: Record<string, { mcp: string[]; command: string[] }> = {
  PostToolUse: { mcp: ['post_tool_use'], command: ['adapter-main.js'] },
  SessionStart: { mcp: ['session_event'], command: ['session-main.js'] },
  UserPromptSubmit: { mcp: ['prompt_guard'], command: ['session-main.js'] },
  SubagentStart: { mcp: ['subagent_start'], command: ['subagent-main.js'] },
  SubagentStop: { mcp: ['subagent_stop'], command: ['subagent-main.js'] },
  PreCompact: { mcp: ['pre_compact'], command: ['compaction-main.js'] },
  PostCompact: { mcp: ['post_compact'], command: ['compaction-main.js'] },
  Stop: { mcp: ['stop_guard', 'quality_guard'], command: ['stop-main.js', 'quality-guard-main.js'] },
};

interface Server {
  call: (method: string, params?: unknown) => Promise<Record<string, unknown>>;
}

async function startServer(env: NodeJS.ProcessEnv): Promise<Server> {
  const child = spawn('node', [serverPath], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  children.push(child);
  const pending = new Map<number, (message: Record<string, unknown>) => void>();
  let buffer = '';
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line.length > 0) {
        const message = JSON.parse(line) as Record<string, unknown>;
        const resolve = pending.get(message.id as number);
        if (resolve) {
          pending.delete(message.id as number);
          resolve(message);
        }
      }
      index = buffer.indexOf('\n');
    }
  });
  let nextId = 0;
  const call = (method: string, params?: unknown): Promise<Record<string, unknown>> =>
    new Promise((resolve) => {
      nextId += 1;
      pending.set(nextId, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: nextId, method, params }) + '\n');
    });
  await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'parity', version: '1' } });
  return { call };
}

const toolText = (response: Record<string, unknown>): string => {
  const result = response.result as { content?: { text?: string }[] };
  return result?.content?.[0]?.text ?? '';
};

const runCommand = (main: string, payload: Record<string, unknown>, env: NodeJS.ProcessEnv): string => {
  const result = spawnSync('node', [join(repoRoot, 'dist', 'codex', main)], {
    input: JSON.stringify(payload),
    env,
    encoding: 'utf8',
  });
  return result.stdout ?? '';
};

const seedRecoveries = (env: NodeJS.ProcessEnv): void => {
  for (const index of [1, 2]) {
    appendRecovery(env, 's1', {
      of: 't' + index,
      inputHash: 'hash' + index,
      at: new Date().toISOString(),
      tool: 'Bash',
      afterMs: 1000,
      afterCalls: 1,
      input: 'npm test',
      chars: 100,
    });
  }
};

describe('hook parity matrix', () => {
  it('wires every lifecycle event on both transports', () => {
    const mcp = hookTargets('hooks.json');
    const command = hookTargets('hooks.command.json');
    for (const [event, expected] of Object.entries(EXPECTED)) {
      expect(mcp[event], 'mcp ' + event).toEqual(expected.mcp);
      expect(command[event], 'command ' + event).toEqual(expected.command);
    }
  });

  it('keeps the two hook files on the same event list', () => {
    expect(Object.keys(hookTargets('hooks.json')).sort()).toEqual(Object.keys(hookTargets('hooks.command.json')).sort());
  });
});

describe('transport behaviour', () => {
  it('writes the same session record from SessionStart on both transports', async () => {
    const mcpEnv = tempEnv();
    const commandEnv = tempEnv();
    const server = await startServer(mcpEnv);
    const response = await server.call('tools/call', {
      name: 'session_event',
      arguments: { session_id: 's1', event: 'SessionStart', cwd: '/tmp/work' },
    });
    expect(toolText(response)).toBe('');
    runCommand('session-main.js', { hook_event_name: 'SessionStart', session_id: 's1', cwd: '/tmp/work' }, commandEnv);

    const readRecord = (env: NodeJS.ProcessEnv): Record<string, unknown> =>
      JSON.parse(readFileSync(join(env.PLUGIN_DATA as string, 'sessions', 's1.json'), 'utf8')) as Record<string, unknown>;
    const mcpRecord = readRecord(mcpEnv);
    const commandRecord = readRecord(commandEnv);
    expect(mcpRecord.session_id).toBe(commandRecord.session_id);
    expect(mcpRecord.cwd).toBe(commandRecord.cwd);
    expect(mcpRecord.goal).toEqual(commandRecord.goal);
  });

  it('reports the same recovery advisory from Stop on both transports', async () => {
    const mcpEnv = tempEnv({ debug: true });
    const commandEnv = tempEnv({ debug: true });
    seedRecoveries(mcpEnv);
    seedRecoveries(commandEnv);

    const server = await startServer(mcpEnv);
    const response = await server.call('tools/call', { name: 'stop_guard', arguments: { session_id: 's1' } });
    const mcpOutput = toolText(response);
    const commandOutput = runCommand('stop-main.js', { hook_event_name: 'Stop', session_id: 's1' }, commandEnv);

    expect(mcpOutput).toContain('dropped results were re-run');
    expect(commandOutput).toBe(mcpOutput);
  });

  it('stays silent for a session with no recent recoveries on both transports', async () => {
    const mcpEnv = tempEnv();
    const commandEnv = tempEnv();
    const server = await startServer(mcpEnv);
    const response = await server.call('tools/call', { name: 'stop_guard', arguments: { session_id: 'quiet' } });
    expect(toolText(response)).toBe('');
    expect(runCommand('stop-main.js', { hook_event_name: 'Stop', session_id: 'quiet' }, commandEnv)).toBe('');
  });
});
