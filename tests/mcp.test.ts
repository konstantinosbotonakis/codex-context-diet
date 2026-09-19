import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { configPath } from '../src/config.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const serverPath = join(repoRoot, 'dist', 'mcp-server.js');

const children: ChildProcessWithoutNullStreams[] = [];
afterEach(() => {
  while (children.length > 0) children.pop()?.kill();
});

interface Server {
  data: string;
  call: (method: string, params?: unknown) => Promise<Record<string, unknown>>;
  child: ChildProcessWithoutNullStreams;
}

async function start(overrides: Record<string, string> = {}): Promise<Server> {
  const data = mkdtempSync(join(tmpdir(), 'cd-mcp-'));
  const env = { ...process.env, PLUGIN_DATA: data, ...overrides };
  writeFileSync(configPath({ PLUGIN_DATA: data } as NodeJS.ProcessEnv), JSON.stringify({ debug: true, minTokens: 10 }));
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
  const started = await call('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test', version: '1' },
  });
  expect(started.result).toBeTruthy();
  return { data, call, child };
}

const toolText = (response: Record<string, unknown>): string => {
  const result = response.result as { content?: { text?: string }[]; isError?: boolean };
  return result?.content?.[0]?.text ?? '';
};

const isError = (response: Record<string, unknown>): boolean =>
  (response.result as { isError?: boolean } | undefined)?.isError === true;

const bigPayload = (id: string) => ({
  session_id: 's1',
  tool_name: 'Bash',
  tool_use_id: id,
  tool_input: { command: 'npm test' },
  tool_response: { output: 'identical output\n'.repeat(400) },
});

const dropAnswers = JSON.stringify({
  needs_contents: 0.05, replaceable: 0.9, keep_call: 0.9, agent_directed: 0.02, behaviour_change: 0.02,
});

describe('the Context Diet MCP server', () => {
  it('lists every tool after initialize', async () => {
    const { call } = await start();
    const listed = await call('tools/list');
    const tools = (listed.result as { tools: { name: string }[] }).tools.map((entry) => entry.name);
    expect(tools).toEqual([
      'post_tool_use', 'prompt_guard', 'stop_guard', 'session_event',
      'subagent_start', 'subagent_stop',
      'quality_guard',
      'pre_compact', 'post_compact',
      'jev_boolean', 'jev_choice', 'jev_score',
    ]);
  });

  it('runs the diet decision through post_tool_use', async () => {
    const { call } = await start({ CONTEXT_DIET_TEST_ANSWERS: dropAnswers });
    const first = await call('tools/call', { name: 'post_tool_use', arguments: bigPayload('t1') });
    expect(toolText(first)).toBe('');
    const second = await call('tools/call', { name: 'post_tool_use', arguments: bigPayload('t2') });
    expect(toolText(second)).toContain('"decision":"block"');
  });

  it('answers a boolean question through jev_boolean', async () => {
    const { call } = await start({ CONTEXT_DIET_TEST_ANSWERS: JSON.stringify({ answer: 0.8 }) });
    const response = await call('tools/call', {
      name: 'jev_boolean',
      arguments: { state: 'the deploy finished cleanly', question: 'Did anything fail?' },
    });
    const parsed = JSON.parse(toolText(response)) as { probability: number; answer: boolean };
    expect(parsed.probability).toBe(0.8);
    expect(parsed.answer).toBe(true);
  });

  it('answers a choice question through jev_choice', async () => {
    const spec = JSON.stringify({
      answer: { choice: 'database', confidence: 0.9, probabilities: { database: 0.9, frontend: 0.1 } },
    });
    const { call } = await start({ CONTEXT_DIET_TEST_ANSWERS: spec });
    const response = await call('tools/call', {
      name: 'jev_choice',
      arguments: { state: 'payouts are failing', question: 'Where does this originate?', options: ['frontend', 'database'] },
    });
    const parsed = JSON.parse(toolText(response)) as { choice: string; confidence: number };
    expect(parsed.choice).toBe('database');
    expect(parsed.confidence).toBe(0.9);
  });

  it('answers a score question through jev_score', async () => {
    const spec = JSON.stringify({ answer: { score: 0.7, confidence: 0.8, probabilities: { quiet: 0.1, noisy: 0.7, unusable: 0.2 } } });
    const { call } = await start({ CONTEXT_DIET_TEST_ANSWERS: spec });
    const response = await call('tools/call', {
      name: 'jev_score',
      arguments: { state: 'the logs look noisy', question: 'How bad is the noise?', levels: ['quiet', 'noisy', 'unusable'] },
    });
    const parsed = JSON.parse(toolText(response)) as { score: number };
    expect(parsed.score).toBe(0.7);
  });

  it('refuses a state over the size limit instead of sending it', async () => {
    const { call } = await start({ CONTEXT_DIET_TEST_ANSWERS: '{"answer":0.5}' });
    const response = await call('tools/call', {
      name: 'jev_boolean',
      arguments: { state: 'x'.repeat(200_001), question: 'anything?' },
    });
    expect(isError(response)).toBe(true);
    expect(toolText(response)).toContain('over the');
  });


  it('snapshots state on pre_compact for the next prompt', async () => {
    const { call, data } = await start({ CONTEXT_DIET_TEST_ANSWERS: dropAnswers });
    await call('tools/call', { name: 'post_tool_use', arguments: bigPayload('t1') });
    const pre = await call('tools/call', { name: 'pre_compact', arguments: { session_id: 's1', trigger: 'auto' } });
    expect(isError(pre)).toBe(false);
    expect(toolText(pre)).toBe('');
    const snapshot = readFileSync(join(data, 'state', 'resurrection-s1.md'), 'utf8');
    expect(snapshot).toContain('[codex-context-diet resurrection]');
    const post = await call('tools/call', { name: 'post_compact', arguments: { session_id: 's1', trigger: 'auto' } });
    expect(isError(post)).toBe(false);
  });

  it('fails safely on an unknown tool', async () => {
    const { call } = await start();
    const response = await call('tools/call', { name: 'nope', arguments: {} });
    expect(isError(response)).toBe(true);
    expect(toolText(response)).toContain('unknown tool');
  });

  it('rejects a call that is missing a required argument', async () => {
    const { call } = await start();
    const response = await call('tools/call', { name: 'post_tool_use', arguments: { session_id: 's1' } });
    expect(isError(response)).toBe(true);
    expect(toolText(response)).toContain('missing required argument');
    expect(toolText(response)).toContain('tool_name');
  });

  it('tolerates an extra argument instead of failing the session', async () => {
    const { call } = await start({ CONTEXT_DIET_TEST_ANSWERS: dropAnswers });
    const response = await call('tools/call', {
      name: 'post_tool_use',
      arguments: { ...bigPayload('t1'), future_field: 'ignored' },
    });
    expect(isError(response)).toBe(false);
  });

  it('reports an unknown method as a JSON-RPC error', async () => {
    const { call } = await start();
    const response = await call('not/a/method');
    const error = response.error as { code?: number; message?: string };
    expect(error?.code).toBe(-32601);
    expect(error?.message).toContain('method not found');
  });

  it('survives a malformed line and keeps answering', async () => {
    const { call, child } = await start();
    child.stdin.write('{ this is not json\n');
    const listed = await call('tools/list');
    const tools = (listed.result as { tools: { name: string }[] }).tools;
    expect(tools.length).toBeGreaterThan(0);
  });

  it('fails jev_boolean without a key instead of calling out', async () => {
    const { call } = await start({
      CONTEXT_DIET_TEST_ANSWERS: '',
      TYPESAFE_API_KEY: '',
      TYPESAFE_KEY_FILE: join(tmpdir(), 'cd-no-such-key-file'),
    });
    const response = await call('tools/call', {
      name: 'jev_boolean',
      arguments: { state: 'anything', question: 'Is this reachable?' },
    });
    expect(isError(response)).toBe(true);
    expect(toolText(response)).toContain('no TypeSafe API key');
  });

  it('rejects a choice that was not among the options', async () => {
    const { call } = await start({ CONTEXT_DIET_TEST_ANSWERS: JSON.stringify({ answer: { choice: 'elsewhere' } }) });
    const response = await call('tools/call', {
      name: 'jev_choice',
      arguments: { state: 'anything', question: 'Where?', options: ['frontend', 'database'] },
    });
    expect(isError(response)).toBe(true);
    expect(toolText(response)).toContain('not one of the supplied options');
  });

  it('rejects a score outside 0..1', async () => {
    const { call } = await start({ CONTEXT_DIET_TEST_ANSWERS: JSON.stringify({ answer: { score: 7 } }) });
    const response = await call('tools/call', {
      name: 'jev_score',
      arguments: { state: 'anything', question: 'How bad?', levels: ['quiet', 'loud'] },
    });
    expect(isError(response)).toBe(true);
    expect(toolText(response)).toContain('outside 0..1');
  });

  it('rejects a probability outside 0..1', async () => {
    const { call } = await start({ CONTEXT_DIET_TEST_ANSWERS: JSON.stringify({ answer: 1.5 }) });
    const response = await call('tools/call', {
      name: 'jev_boolean',
      arguments: { state: 'anything', question: 'Is it up?' },
    });
    expect(isError(response)).toBe(true);
    expect(toolText(response)).toContain('outside 0..1');
  });

  it('rejects malformed probabilities and unknown entries', async () => {
    const malformed = JSON.stringify({ answer: { choice: 'database', probabilities: { database: 'high' } } });
    const first = await start({ CONTEXT_DIET_TEST_ANSWERS: malformed });
    const badShape = await first.call('tools/call', {
      name: 'jev_choice',
      arguments: { state: 'anything', question: 'Where?', options: ['frontend', 'database'] },
    });
    expect(isError(badShape)).toBe(true);
    expect(toolText(badShape)).toContain('malformed probabilities');

    const unknown = JSON.stringify({ answer: { choice: 'database', probabilities: { database: 0.8, cache: 0.2 } } });
    const second = await start({ CONTEXT_DIET_TEST_ANSWERS: unknown });
    const unknownEntry = await second.call('tools/call', {
      name: 'jev_choice',
      arguments: { state: 'anything', question: 'Where?', options: ['frontend', 'database'] },
    });
    expect(isError(unknownEntry)).toBe(true);
    expect(toolText(unknownEntry)).toContain('entries that were not supplied');
  });
});
