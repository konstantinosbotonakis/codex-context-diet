import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sessionKey, sessionsDir } from '../cache.js';
import { loadConfig } from '../config.js';
import { keyWarning, problemFromError } from './keyWarning.js';
import { appendEvent } from './log.js';
import { assessPrompt } from './promptGuard.js';
import { redactText } from '../privacy.js';
import { configuredAsker } from './transport.js';
import { takeResurrection } from './compaction.js';
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
    const asker = configuredAsker({ ...config, requestTimeoutMs: config.promptGuardTimeoutMs }, env);
    const started = Date.now();
    const assessment = await assessPrompt(context, asker, config);
    appendEvent(env, config, {
        kind: 'prompt_guard',
        provider: config.provider,
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
        // The goal is replayed in the diet state and in the compaction snapshot,
        // so it is redacted once here, at the point it is captured.
        const safePrompt = redactText(prompt, config.privacyMode).text;
        const stdout = config.promptGuard
            ? await promptGuardOutput(env, config, sessionId, { cwd, recent: existing?.goal ?? [], prompt: safePrompt })
            : null;
        writeRecord(env, {
            session_id: sessionId,
            cwd,
            model,
            started_at: startedAt,
            goal: [...(existing?.goal ?? []), safePrompt].slice(-MAX_GOALS),
        });
        // A snapshot written by PreCompact rides in the first prompt after the
        // compaction, which is the hook where model-visible context is supported.
        const resurrection = takeResurrection(env, sessionId, config);
        if (resurrection === null)
            return stdout === null ? '' : JSON.stringify(stdout);
        const merged = (stdout ?? {});
        const hook = (merged.hookSpecificOutput ?? {});
        hook.hookEventName = 'UserPromptSubmit';
        hook.additionalContext = [resurrection, text(hook.additionalContext)]
            .filter((part) => part.length > 0)
            .join('\n\n');
        merged.hookSpecificOutput = hook;
        return JSON.stringify(merged);
    }
    catch {
        // never block a session
    }
    return '';
}
//# sourceMappingURL=session.js.map