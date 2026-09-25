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
import { existsSync, mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { appendEvent } from './codex/log.js';
import { main as adapterMain } from './codex/adapter.js';
import { main as sessionMain } from './codex/session.js';
import { handleCompaction } from './codex/compaction.js';
import { handleSubagent } from './codex/subagent.js';
import { handleStop } from './codex/qualityGuard.js';
import { handleStopGuard } from './codex/stopGuard.js';
import { configuredAsker } from './codex/transport.js';
import { loadConfig, pluginDataDir } from './config.js';
import { redactText } from './privacy.js';
import { noulAnswer } from './request.js';
const PROTOCOL_VERSION = '2024-11-05';
const SERVER_NAME = 'context-diet';
const MAX_STATE_CHARS = 120_000;
const text = (value) => (typeof value === 'string' ? value : '');
const list = (value) => Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item.trim().length > 0) : [];
const ok = (body) => ({ content: [{ type: 'text', text: body }] });
const fail = (body) => ({ content: [{ type: 'text', text: body }], isError: true });
function tool(name, description, properties, required) {
    return { name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false } };
}
const TOOLS = [
    tool('post_tool_use', 'Judge one tool result and return the PostToolUse hook output, or nothing when the result is kept.', {
        session_id: { type: 'string' },
        tool_name: { type: 'string' },
        tool_input: { type: 'object' },
        tool_response: {},
        tool_use_id: { type: 'string' },
        cwd: { type: 'string' },
    }, ['session_id', 'tool_name', 'tool_response']),
    tool('prompt_guard', 'Run the prompt guard for one user prompt and return the UserPromptSubmit hook output, or nothing.', { session_id: { type: 'string' }, prompt: { type: 'string' }, cwd: { type: 'string' } }, ['session_id', 'prompt']),
    tool('stop_guard', 'Report once per session when several dropped results were re-run recently.', { session_id: { type: 'string' } }, ['session_id']),
    tool('session_event', 'Record a session lifecycle event such as SessionStart or SessionEnd.', { session_id: { type: 'string' }, event: { type: 'string' } }, ['session_id', 'event']),
    tool('subagent_start', 'Return the concise result contract a subagent should follow.', { agent_id: { type: 'string' }, agent_type: { type: 'string' } }, []),
    tool('subagent_stop', 'Judge whether a finished subagent result is ready for the parent, and ask for one revision when it is not.', {
        agent_id: { type: 'string' },
        agent_type: { type: 'string' },
        last_assistant_message: { type: 'string' },
        stop_hook_active: { type: 'boolean' },
    }, []),
    tool('quality_guard', 'Optional completion-quality check for the Stop event. Off unless qualityGuard is enabled; returns a continuation reason when the turn should not finish yet.', {
        turn_id: { type: 'string' },
        last_assistant_message: { type: 'string' },
        stop_hook_active: { type: 'boolean' },
    }, []),
    tool('pre_compact', 'Snapshot compact plugin-owned session state before Codex compacts the chat.', { session_id: { type: 'string' }, trigger: { type: 'string' } }, ['session_id']),
    tool('post_compact', 'Record that compaction finished so the next prompt can carry the snapshot.', { session_id: { type: 'string' }, trigger: { type: 'string' } }, ['session_id']),
    tool('jev_boolean', 'Ask the configured System One provider a yes/no question about a state and return the probability. Cheaper than a reasoning model for one calibrated judgement. Answers from Jev by default, or from a local checkpoint when one is configured.', { state: {}, question: { type: 'string' } }, ['state', 'question']),
    tool('jev_choice', 'Ask the configured System One provider to pick one option for a state and return the choice with its probability distribution. Include a no-match option when nothing may fit.', { state: {}, question: { type: 'string' }, options: { type: 'array', items: { type: 'string' } } }, ['state', 'question', 'options']),
    tool('jev_score', 'Ask the configured System One provider to rate a state along an ordered list of levels and return the probability-weighted score. Provide the levels from lowest to highest, each one able to stand alone.', { state: {}, question: { type: 'string' }, levels: { type: 'array', items: { type: 'string' } } }, ['state', 'question', 'levels']),
    tool('jev_ask', 'Ask the configured System One provider several independent questions about one state in a single request. The questions run in parallel and cannot see one another, so state every speculative premise explicitly. Use it for classification, filtering, routing and other simple judgements over the same text.', {
        state: {},
        questions: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    id: { type: 'string' },
                    type: { type: 'string' },
                    question: { type: 'string' },
                    options: { type: 'array', items: { type: 'string' } },
                    levels: { type: 'array', items: { type: 'string' } },
                },
                required: ['id', 'type', 'question'],
                additionalProperties: false,
            },
        },
    }, ['state', 'questions']),
];
function jevSetup(env) {
    const config = loadConfig(env);
    const asker = configuredAsker(config, env);
    if (asker === null) {
        return { error: 'no TypeSafe API key: set TYPESAFE_API_KEY or write ~/.typesafe_key' };
    }
    return { config, asker };
}
function stateOf(args, config) {
    const state = text(args.state);
    if (state.trim().length === 0)
        return { error: 'state must not be empty' };
    if (state.length > MAX_STATE_CHARS)
        return { error: 'state is ' + state.length + ' characters, over the ' + MAX_STATE_CHARS + ' limit' };
    return redactText(state, config.privacyMode).text;
}
async function callTool(name, args, env) {
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
        // Shared with the command fallback so both transports answer identically.
        return ok(handleStopGuard({ session_id: text(args.session_id) }, env));
    }
    if (name === 'session_event') {
        const config = loadConfig(env);
        const event = text(args.event);
        appendEvent(env, config, { kind: 'session_event', event, session: text(args.session_id) });
        // SessionStart goes through the same session handler the command hook
        // uses, so the session record is written identically on both transports.
        if (event === 'SessionStart') {
            const payload = {
                hook_event_name: 'SessionStart',
                session_id: text(args.session_id),
                cwd: text(args.cwd) || process.cwd(),
            };
            return ok(await sessionMain(JSON.stringify(payload), env));
        }
        return ok('');
    }
    if (name === 'quality_guard') {
        const output = await handleStop({
            turn_id: text(args.turn_id),
            last_assistant_message: text(args.last_assistant_message),
            stop_hook_active: args.stop_hook_active === true,
        }, env);
        return ok(output);
    }
    if (name === 'subagent_start' || name === 'subagent_stop') {
        const output = await handleSubagent({
            hook_event_name: name === 'subagent_start' ? 'SubagentStart' : 'SubagentStop',
            agent_id: text(args.agent_id),
            agent_type: text(args.agent_type),
            last_assistant_message: text(args.last_assistant_message),
            stop_hook_active: args.stop_hook_active === true,
        }, env);
        return ok(output);
    }
    if (name === 'pre_compact' || name === 'post_compact') {
        const output = await handleCompaction({
            hook_event_name: name === 'pre_compact' ? 'PreCompact' : 'PostCompact',
            session_id: text(args.session_id),
            trigger: text(args.trigger),
        }, env);
        return ok(output);
    }
    if (name === 'jev_boolean' || name === 'jev_choice' || name === 'jev_score') {
        const setup = jevSetup(env);
        if ('error' in setup)
            return fail(setup.error);
        const { config, asker } = setup;
        const state = stateOf(args, config);
        if (typeof state !== 'string')
            return fail(state.error);
        const question = text(args.question);
        if (question.trim().length === 0)
            return fail('question must not be empty');
        if (name === 'jev_boolean') {
            const response = await asker.ask(state, { answer: { type: 'noul', instructions: question } });
            const probability = noulAnswer(response.answers, 'answer');
            if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
                return fail('Jev returned a probability outside 0..1');
            }
            return ok(JSON.stringify({ probability, answer: probability >= 0.5, model: response.model ?? null, input_tokens: inputTokens(response) }));
        }
        const items = list(name === 'jev_choice' ? args.options : args.levels);
        if (items.length < 2)
            return fail((name === 'jev_choice' ? 'options' : 'levels') + ' needs at least two entries');
        if (items.length > 20)
            return fail('at most 20 entries are accepted');
        const questions = name === 'jev_choice'
            ? { answer: { type: 'choice', instructions: question, criteria: Object.fromEntries(items.map((item) => [item, null])) } }
            : { answer: { type: 'score', instructions: question, criteria: items } };
        const response = await asker.ask(state, questions);
        const answer = (response.answers.answer ?? {});
        const confidence = typeof answer.confidence === 'number' && Number.isFinite(answer.confidence) ? answer.confidence : null;
        const rawProbabilities = answer.probabilities;
        const probabilities = rawProbabilities === undefined ? null : probabilitiesOf(rawProbabilities);
        if (rawProbabilities !== undefined && probabilities === null) {
            return fail('Jev returned malformed probabilities');
        }
        if (probabilities !== null && Object.keys(probabilities).some((key) => !items.includes(key))) {
            return fail('Jev returned probabilities for entries that were not supplied');
        }
        // A semantic answer that does not fit the request is an error, not data.
        if (name === 'jev_choice') {
            const choice = typeof answer.choice === 'string' ? answer.choice : null;
            if (choice === null || !items.includes(choice)) {
                return fail('Jev returned a choice that is not one of the supplied options');
            }
            return ok(JSON.stringify({ choice, probabilities, confidence, model: response.model ?? null, input_tokens: inputTokens(response) }));
        }
        const score = typeof answer.score === 'number' && Number.isFinite(answer.score) && answer.score >= 0 && answer.score <= 1
            ? answer.score
            : null;
        if (score === null)
            return fail('Jev returned a score outside 0..1');
        return ok(JSON.stringify({ score, probabilities, confidence, model: response.model ?? null, input_tokens: inputTokens(response) }));
    }
    if (name === 'jev_ask') {
        const setup = jevSetup(env);
        if ('error' in setup)
            return fail(setup.error);
        const { config, asker } = setup;
        const state = stateOf(args, config);
        if (typeof state !== 'string')
            return fail(state.error);
        const entries = Array.isArray(args.questions) ? args.questions : [];
        if (entries.length === 0)
            return fail('questions must be a non-empty array');
        if (entries.length > 8)
            return fail('at most 8 questions are accepted in one request');
        const questions = {};
        const kindById = {};
        const itemsById = {};
        for (const entry of entries) {
            if (!entry || typeof entry !== 'object' || Array.isArray(entry))
                return fail('every question must be an object');
            const record = entry;
            const id = text(record.id).trim();
            const kind = text(record.type).trim();
            const prompt = text(record.question).trim();
            if (id.length === 0)
                return fail('every question needs a non-empty id');
            if (Object.prototype.hasOwnProperty.call(questions, id))
                return fail('duplicate question id: ' + id);
            if (prompt.trim().length === 0)
                return fail('question ' + id + ' has no text');
            if (kind === 'boolean' || kind === 'noul') {
                questions[id] = { type: 'noul', instructions: prompt };
                kindById[id] = 'noul';
                continue;
            }
            if (kind !== 'choice' && kind !== 'score') {
                return fail('question ' + id + ' has an unknown type: ' + kind + ' (boolean, choice or score)');
            }
            const values = list(kind === 'choice' ? record.options : record.levels);
            const noun = kind === 'choice' ? 'options' : 'levels';
            if (values.length < 2)
                return fail('question ' + id + ' needs at least two ' + noun);
            if (values.length > 20)
                return fail('question ' + id + ' has more than 20 ' + noun);
            itemsById[id] = values;
            questions[id] = kind === 'choice'
                ? { type: 'choice', instructions: prompt, criteria: Object.fromEntries(values.map((item) => [item, null])) }
                : { type: 'score', instructions: prompt, criteria: values };
            kindById[id] = kind;
        }
        const response = await asker.ask(state, questions);
        const answers = {};
        for (const id of Object.keys(questions)) {
            const answer = (response.answers[id] ?? {});
            const items = itemsById[id];
            if (kindById[id] === 'noul') {
                const probability = noulAnswer(response.answers, id);
                if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
                    return fail('question ' + id + ' returned a probability outside 0..1');
                }
                answers[id] = { probability, answer: probability >= 0.5 };
                continue;
            }
            const rawProbabilities = answer.probabilities;
            const probabilities = rawProbabilities === undefined ? null : probabilitiesOf(rawProbabilities);
            if (rawProbabilities !== undefined && probabilities === null) {
                return fail('question ' + id + ' returned malformed probabilities');
            }
            if (probabilities !== null && Object.keys(probabilities).some((key) => !items.includes(key))) {
                return fail('question ' + id + ' returned probabilities for entries that were not supplied');
            }
            const confidence = typeof answer.confidence === 'number' && Number.isFinite(answer.confidence) ? answer.confidence : null;
            if (kindById[id] === 'choice') {
                const choice = typeof answer.choice === 'string' ? answer.choice : null;
                if (choice === null || !items.includes(choice)) {
                    return fail('question ' + id + ' returned a choice that is not one of the supplied options');
                }
                answers[id] = { choice, probabilities, confidence };
                continue;
            }
            const score = typeof answer.score === 'number' && Number.isFinite(answer.score) && answer.score >= 0 && answer.score <= 1
                ? answer.score
                : null;
            if (score === null)
                return fail('question ' + id + ' returned a score outside 0..1');
            answers[id] = { score, probabilities, confidence };
        }
        return ok(JSON.stringify({ answers, model: response.model ?? null, input_tokens: inputTokens(response) }));
    }
    return fail('unknown tool: ' + name);
}
/** Probabilities must be an object of finite numbers in 0..1, or nothing. */
function probabilitiesOf(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        return null;
    const out = {};
    for (const [key, value] of Object.entries(raw)) {
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1)
            return null;
        out[key] = value;
    }
    return out;
}
function inputTokens(response) {
    const value = response.usage?.input_tokens;
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
async function handle(message, env) {
    const id = message.id;
    const method = text(message.method);
    const params = (message.params && typeof message.params === 'object' ? message.params : {});
    if (method === 'initialize') {
        return { jsonrpc: '2.0', id, result: { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: SERVER_NAME, version: '1.0.0' } } };
    }
    if (method === 'notifications/initialized' || method === 'notifications/cancelled')
        return null;
    if (method === 'ping')
        return { jsonrpc: '2.0', id, result: {} };
    if (method === 'tools/list')
        return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
    if (method === 'tools/call') {
        const name = text(params.name);
        const args = (params.arguments && typeof params.arguments === 'object' ? params.arguments : {});
        const definition = TOOLS.find((entry) => entry.name === name);
        if (!definition)
            return { jsonrpc: '2.0', id, result: fail('unknown tool: ' + name) };
        // Required arguments are checked here so a missing field is a clear
        // message instead of a silent no-op downstream. Extra fields are
        // tolerated: a future host that adds one must not break the session.
        const schema = definition.inputSchema;
        const missing = schema.required.filter((key) => {
            const value = args[key];
            if (value === undefined || value === null)
                return true;
            return schema.properties[key]?.type === 'string' && text(value).trim().length === 0;
        });
        if (missing.length > 0) {
            return { jsonrpc: '2.0', id, result: fail('missing required argument(s): ' + missing.join(', ')) };
        }
        try {
            return { jsonrpc: '2.0', id, result: await callTool(name, args, env) };
        }
        catch (error) {
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
    if (trimmed.length === 0)
        return;
    let message;
    try {
        const parsed = JSON.parse(trimmed);
        if (!parsed || typeof parsed !== 'object')
            return;
        message = parsed;
    }
    catch {
        return;
    }
    void handle(message, env)
        .then((response) => {
        if (response === null)
            return;
        process.stdout.write(JSON.stringify(response) + '\n');
    })
        .catch(() => {
        // A failed request must never take the server down.
    });
});
if (!existsSync(pluginDataDir(env))) {
    try {
        mkdirSync(pluginDataDir(env), { recursive: true });
    }
    catch {
        // The hooks create it when they need it.
    }
}
//# sourceMappingURL=mcp-server.js.map