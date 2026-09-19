#!/usr/bin/env node
/**
 * Context Diet MCP server (stdio).
 *
 * Two jobs in one process:
 *
 * 1. Hook handlers for `mcp_tool` lifecycle wiring: `post_tool_use`,
 *    `prompt_guard`, `stop_guard` and `session_event` call the same decision
 *    modules the command hooks use, so behaviour cannot fork. One long-lived
 *    process removes the per-call Node spawn and reuses the HTTP pool.
 * 2. Direct Jev primitives for Codex: `jev_boolean`, `jev_choice` and
 *    `jev_score`, with size limits, redaction, validated answers and safe
 *    failure.
 *
 * The protocol is newline-delimited JSON-RPC 2.0 over stdin/stdout, per the
 * MCP stdio transport. No dependencies.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { appendEvent } from './codex/log.js';
import { main as adapterMain } from './codex/adapter.js';
import { main as sessionMain } from './codex/session.js';
import { handleCompaction } from './codex/compaction.js';
import { createAsker } from './codex/transport.js';
import { readRecoveries } from './cache.js';
import { loadConfig, pluginDataDir } from './config.js';
import type { DietConfig } from './config.js';
import { resolveApiKey } from './key.js';
import { redactText } from './privacy.js';
import { noulAnswer } from './request.js';
import type { JevAsker } from './types.js';

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_NAME = 'context-diet';
const MAX_STATE_CHARS = 120_000;
const RECOVERY_WINDOW_MS = 15 * 60 * 1000;
const RECOVERY_WARN_AT = 2;

type Args = Record<string, unknown>;

const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const list = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : [];

const ok = (body: string) => ({ content: [{ type: 'text', text: body }] });
const fail = (body: string) => ({ content: [{ type: 'text', text: body }], isError: true });

function tool(name: string, description: string, properties: Record<string, unknown>, required: string[]) {
  return { name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false } };
}

const TOOLS = [
  tool(
    'post_tool_use',
    'Judge one tool result and return the PostToolUse hook output, or nothing when the result is kept.',
    {
      session_id: { type: 'string' },
      tool_name: { type: 'string' },
      tool_input: { type: 'object' },
      tool_response: {},
      tool_use_id: { type: 'string' },
      cwd: { type: 'string' },
    },
    ['session_id', 'tool_name', 'tool_response'],
  ),
  tool(
    'prompt_guard',
    'Run the prompt guard for one user prompt and return the UserPromptSubmit hook output, or nothing.',
    { session_id: { type: 'string' }, prompt: { type: 'string' }, cwd: { type: 'string' } },
    ['session_id', 'prompt'],
  ),
  tool(
    'stop_guard',
    'Report once per session when several dropped results were re-run recently.',
    { session_id: { type: 'string' } },
    ['session_id'],
  ),
  tool(
    'session_event',
    'Record a session lifecycle event such as SessionStart or SessionEnd.',
    { session_id: { type: 'string' }, event: { type: 'string' } },
    ['session_id', 'event'],
  ),
  tool(
    'pre_compact',
    'Snapshot compact plugin-owned session state before Codex compacts the chat.',
    { session_id: { type: 'string' }, trigger: { type: 'string' } },
    ['session_id'],
  ),
  tool(
    'post_compact',
    'Record that compaction finished so the next prompt can carry the snapshot.',
    { session_id: { type: 'string' }, trigger: { type: 'string' } },
    ['session_id'],
  ),
  tool(
    'jev_boolean',
    'Ask Jev a yes/no question about a state and return the probability. Cheaper than a reasoning model for one calibrated judgement.',
    { state: {}, question: { type: 'string' } },
    ['state', 'question'],
  ),
  tool(
    'jev_choice',
    'Ask Jev to pick one option for a state and return the choice with its probability distribution.',
    { state: {}, question: { type: 'string' }, options: { type: 'array', items: { type: 'string' } } },
    ['state', 'question', 'options'],
  ),
  tool(
    'jev_score',
    'Ask Jev to rate a state along an ordered list of levels and return the probability-weighted score. Provide the levels from lowest to highest.',
    { state: {}, question: { type: 'string' }, levels: { type: 'array', items: { type: 'string' } } },
    ['state', 'question', 'levels'],
  ),
];

type JevSetup = { error: string } | { config: DietConfig; asker: JevAsker };

function jevSetup(env: NodeJS.ProcessEnv): JevSetup {
  const config = loadConfig(env);
  const { key } = resolveApiKey(config, env);
  if (key === null && !env.CONTEXT_DIET_TEST_ANSWERS) {
    return { error: 'no TypeSafe API key: set TYPESAFE_API_KEY or write ~/.typesafe_key' };
  }
  return { config, asker: createAsker(config, key ?? 'test-key', env) };
}

function stateOf(args: Args, config: { privacyMode: 'strict' | 'standard' | 'off' }): string | { error: string } {
  const state = text(args.state);
  if (state.trim().length === 0) return { error: 'state must not be empty' };
  if (state.length > MAX_STATE_CHARS) return { error: 'state is ' + state.length + ' characters, over the ' + MAX_STATE_CHARS + ' limit' };
  return redactText(state, config.privacyMode).text;
}

async function callTool(name: string, args: Args, env: NodeJS.ProcessEnv): Promise<unknown> {
  if (name === 'post_tool_use') {
    const payload = {
      hook_event_name: 'PostToolUse',
      session_id: text(args.session_id),
      tool_name: text(args.tool_name),
      tool_use_id: text(args.tool_use_id),
      tool_input: args.tool_input ?? {},
      tool_response: args.tool_response ?? {},
      cwd: text(args.cwd) || process.cwd(),
    };
    return ok(await adapterMain(JSON.stringify(payload), env));
  }
  if (name === 'prompt_guard') {
    const payload = {
      hook_event_name: 'UserPromptSubmit',
      session_id: text(args.session_id),
      prompt: text(args.prompt),
      cwd: text(args.cwd) || process.cwd(),
    };
    return ok(await sessionMain(JSON.stringify(payload), env));
  }
  if (name === 'stop_guard') {
    const sessionId = text(args.session_id);
    const recent = readRecoveries(env, sessionId).filter((record) => {
      const at = Date.parse(record.at);
      return Number.isFinite(at) && Date.now() - at <= RECOVERY_WINDOW_MS;
    });
    if (recent.length < RECOVERY_WARN_AT) return ok('');
    const marker = join(pluginDataDir(env), 'state', 'stop-guard.json');
    try {
      const previous = JSON.parse(readFileSync(marker, 'utf8')) as { session_id?: string };
      if (previous.session_id === sessionId) return ok('');
    } catch {
      // no marker yet
    }
    try {
      mkdirSync(join(pluginDataDir(env), 'state'), { recursive: true });
      writeFileSync(marker, JSON.stringify({ session_id: sessionId, at: new Date().toISOString() }) + '\n');
    } catch {
      // best effort
    }
    return ok(
      JSON.stringify({
        systemMessage:
          '[codex-context-diet] ' + recent.length + ' dropped results were re-run in the last 15 minutes. ' +
          'Consider a higher minTokens or a tool policy for the commands involved.',
      }),
    );
  }
  if (name === 'session_event') {
    const config = loadConfig(env);
    appendEvent(env, config, { kind: 'session_event', event: text(args.event), session: text(args.session_id) });
    return ok('');
  }
  if (name === 'pre_compact' || name === 'post_compact') {
    const output = await handleCompaction(
      {
        hook_event_name: name === 'pre_compact' ? 'PreCompact' : 'PostCompact',
        session_id: text(args.session_id),
        trigger: text(args.trigger),
      },
      env,
    );
    return ok(output);
  }
  if (name === 'jev_boolean' || name === 'jev_choice' || name === 'jev_score') {
    const setup = jevSetup(env);
    if ('error' in setup) return fail(setup.error);
    const { config, asker } = setup;
    const state = stateOf(args, config);
    if (typeof state !== 'string') return fail(state.error);
    const question = text(args.question);
    if (question.trim().length === 0) return fail('question must not be empty');
    if (name === 'jev_boolean') {
      const response = await asker.ask(state, { answer: { type: 'noul', instructions: question } });
      const probability = noulAnswer(response.answers, 'answer');
      return ok(JSON.stringify({ probability, answer: probability >= 0.5, model: response.model ?? null, input_tokens: inputTokens(response) }));
    }
    const items = list(name === 'jev_choice' ? args.options : args.levels);
    if (items.length < 2) return fail((name === 'jev_choice' ? 'options' : 'levels') + ' needs at least two entries');
    if (items.length > 20) return fail('at most 20 entries are accepted');
    const questions = name === 'jev_choice'
      ? { answer: { type: 'choice' as const, instructions: question, criteria: Object.fromEntries(items.map((item) => [item, null])) } }
      : { answer: { type: 'score' as const, instructions: question, criteria: items } };
    const response = await asker.ask(state, questions);
    const answer = (response.answers.answer ?? {}) as unknown as Record<string, unknown>;
    return ok(
      JSON.stringify({
        choice: typeof answer.choice === 'string' ? answer.choice : null,
        score: typeof answer.score === 'number' ? answer.score : null,
        probabilities: answer.probabilities ?? null,
        confidence: typeof answer.confidence === 'number' ? answer.confidence : null,
        model: response.model ?? null,
        input_tokens: inputTokens(response),
      }),
    );
  }
  return fail('unknown tool: ' + name);
}

function inputTokens(response: { usage?: { input_tokens?: unknown } }): number | null {
  const value = response.usage?.input_tokens;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

async function handle(message: Record<string, unknown>, env: NodeJS.ProcessEnv): Promise<Record<string, unknown> | null> {
  const id = message.id;
  const method = text(message.method);
  const params = (message.params && typeof message.params === 'object' ? message.params : {}) as Args;
  if (method === 'initialize') {
    return { jsonrpc: '2.0', id, result: { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: SERVER_NAME, version: '1.0.0' } } };
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return null;
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
  if (method === 'tools/call') {
    const name = text(params.name);
    const args = (params.arguments && typeof params.arguments === 'object' ? params.arguments : {}) as Args;
    try {
      return { jsonrpc: '2.0', id, result: await callTool(name, args, env) };
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      return { jsonrpc: '2.0', id, result: fail('context-diet tool failed: ' + messageText) };
    }
  }
  return { jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found: ' + method } };
}

const env = process.env;
const reader = createInterface({ input: process.stdin, crlfDelay: Infinity });
reader.on('line', (line) => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;
  let message: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object') return;
    message = parsed as Record<string, unknown>;
  } catch {
    return;
  }
  void handle(message, env)
    .then((response) => {
      if (response === null) return;
      process.stdout.write(JSON.stringify(response) + '\n');
    })
    .catch(() => {
      // A failed request must never take the server down.
    });
});

if (!existsSync(pluginDataDir(env))) {
  try {
    mkdirSync(pluginDataDir(env), { recursive: true });
  } catch {
    // The hooks create it when they need it.
  }
}
