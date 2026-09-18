import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sessionKey, sessionsDir } from '../cache.js';
import { loadConfig } from '../config.js';
import { resolveApiKey } from '../key.js';
import { keyWarning, problemFromError } from './keyWarning.js';
import { appendEvent } from './log.js';
import { assessPrompt } from './promptGuard.js';
import { createAsker } from './transport.js';
const MAX_GOALS = 3;
const MAX_PROMPT_CHARS = 500;
function recordPath(env, sessionId) {
    return join(sessionsDir(env), sessionKey(sessionId) + '.json');
}
function text(value) {
    return typeof value === 'string' ? value : '';
}
function readRecord(env, sessionId) {
    try {
        const parsed = JSON.parse(readFileSync(recordPath(env, sessionId), 'utf8'));
        if (!parsed || typeof parsed !== 'object')
            return null;
        const record = parsed;
        return {
            session_id: text(record.session_id) || sessionId,
            cwd: text(record.cwd),
            model: text(record.model),
            started_at: text(record.started_at),
            goal: Array.isArray(record.goal)
                ? record.goal.filter((entry) => typeof entry === 'string')
                : [],
        };
    }
    catch {
        return null;
    }
}
function writeRecord(env, record) {
    try {
        mkdirSync(sessionsDir(env), { recursive: true });
        writeFileSync(recordPath(env, record.session_id), JSON.stringify(record, null, 2));
    }
    catch {
        // goal capture is best effort; the diet works without it
    }
}
/** The goal the diet state carries: the last few prompts, joined. */
export function readGoal(env, sessionId) {
    const record = readRecord(env, sessionId);
    if (!record || record.goal.length === 0)
        return { goal: '', goalIndex: 0 };
    return { goal: record.goal.join('\n'), goalIndex: record.goal.length - 1 };
}
/**
 * Opt-in, never blocking. Returns one line of developer context, or a one-off
 * warning when Jev could not be asked at all, or nothing.
 */
async function promptGuardOutput(env, config, sessionId, context) {
    const { key } = resolveApiKey(config, env);
    const asker = key !== null || env.CONTEXT_DIET_TEST_ANSWERS
        ? createAsker({ ...config, requestTimeoutMs: config.promptGuardTimeoutMs }, key ?? 'test-key', env)
        : null;
    const started = Date.now();
    const assessment = await assessPrompt(context, asker, config);
    appendEvent(env, config, {
        kind: 'prompt_guard',
        asked: asker !== null,
        flagged: assessment.risk !== null && assessment.risk.hazards.length > 0,
        hazards: assessment.risk?.hazards ?? [],
        chars: context.prompt.length,
        ms: Date.now() - started,
        error: assessment.error,
        inputTokens: assessment.inputTokens,
    });
    const problem = asker === null ? 'missing' : assessment.error === null ? null : problemFromError(assessment.error);
    if (problem !== null) {
        const warning = keyWarning(env, sessionId, problem);
        if (warning !== null) {
            appendEvent(env, config, { kind: problem === 'missing' ? 'key_missing' : 'key_rejected', problem });
            return { systemMessage: warning };
        }
    }
    const line = assessment.risk?.line ?? null;
    if (line === null)
        return null;
    return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: line } };
}
/** SessionStart records the session. UserPromptSubmit keeps the goals and runs the guard. Never throws. */
export async function main(stdin, env) {
    try {
        const parsed = JSON.parse(stdin);
        if (!parsed || typeof parsed !== 'object')
            return '';
        const payload = parsed;
        const event = text(payload.hook_event_name);
        const sessionId = text(payload.session_id);
        if (sessionId.length === 0)
            return '';
        const existing = readRecord(env, sessionId);
        const cwd = text(payload.cwd) || existing?.cwd || '';
        const model = text(payload.model) || existing?.model || '';
        const startedAt = existing?.started_at || new Date().toISOString();
        if (event === 'SessionStart') {
            writeRecord(env, { session_id: sessionId, cwd, model, started_at: startedAt, goal: existing?.goal ?? [] });
            return '';
        }
        if (event !== 'UserPromptSubmit')
            return '';
        const prompt = text(payload.prompt).trim().slice(0, MAX_PROMPT_CHARS);
        if (prompt.length === 0)
            return '';
        const config = loadConfig(env);
        const stdout = config.promptGuard
            ? await promptGuardOutput(env, config, sessionId, { cwd, recent: existing?.goal ?? [], prompt })
            : null;
        writeRecord(env, {
            session_id: sessionId,
            cwd,
            model,
            started_at: startedAt,
            goal: [...(existing?.goal ?? []), prompt].slice(-MAX_GOALS),
        });
        return stdout === null ? '' : JSON.stringify(stdout);
    }
    catch {
        // never block a session
    }
    return '';
}
//# sourceMappingURL=session.js.map