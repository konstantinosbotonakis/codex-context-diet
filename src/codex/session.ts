import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sessionKey, sessionsDir } from '../cache.js';
import { loadConfig, type DietConfig } from '../config.js';
import { resolveApiKey } from '../key.js';
import { appendEvent } from './log.js';
import { assessPrompt, type PromptContext } from './promptGuard.js';
import { createAsker } from './transport.js';

export interface SessionRecord {
  session_id: string;
  cwd: string;
  model: string;
  started_at: string;
  goal: string[];
}

const MAX_GOALS = 3;
const MAX_PROMPT_CHARS = 500;

function recordPath(env: NodeJS.ProcessEnv, sessionId: string): string {
  return join(sessionsDir(env), sessionKey(sessionId) + '.json');
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function readRecord(env: NodeJS.ProcessEnv, sessionId: string): SessionRecord | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(recordPath(env, sessionId), 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    const record = parsed as Record<string, unknown>;
    return {
      session_id: text(record.session_id) || sessionId,
      cwd: text(record.cwd),
      model: text(record.model),
      started_at: text(record.started_at),
      goal: Array.isArray(record.goal)
        ? record.goal.filter((entry): entry is string => typeof entry === 'string')
        : [],
    };
  } catch {
    return null;
  }
}

function writeRecord(env: NodeJS.ProcessEnv, record: SessionRecord): void {
  try {
    mkdirSync(sessionsDir(env), { recursive: true });
    writeFileSync(recordPath(env, record.session_id), JSON.stringify(record, null, 2));
  } catch {
    // goal capture is best effort; the diet works without it
  }
}

/** The goal the diet state carries: the last few prompts, joined. */
export function readGoal(env: NodeJS.ProcessEnv, sessionId: string): { goal: string; goalIndex: number } {
  const record = readRecord(env, sessionId);
  if (!record || record.goal.length === 0) return { goal: '', goalIndex: 0 };
  return { goal: record.goal.join('\n'), goalIndex: record.goal.length - 1 };
}

/**
 * The prompt guard is opt-in and never blocks. It returns one line of developer
 * context or nothing. It runs on the critical path, so it gets a shorter
 * deadline than the diet hook.
 */
async function promptRiskLine(
  env: NodeJS.ProcessEnv,
  config: DietConfig,
  context: PromptContext,
): Promise<string | null> {
  const { key } = resolveApiKey(config, env);
  const asker =
    key !== null || env.CONTEXT_DIET_TEST_ANSWERS
      ? createAsker({ ...config, requestTimeoutMs: config.promptGuardTimeoutMs }, key ?? 'test-key', env)
      : null;
  const started = Date.now();
  const risk = await assessPrompt(context, asker, config);
  appendEvent(env, config, {
    kind: 'prompt_guard',
    flagged: risk !== null && risk.hazards.length > 0,
    hazards: risk?.hazards ?? [],
    chars: context.prompt.length,
    ms: Date.now() - started,
  });
  return risk?.line ?? null;
}

/** SessionStart records the session. UserPromptSubmit keeps the goals and runs the guard. Never throws. */
export async function main(stdin: string, env: NodeJS.ProcessEnv): Promise<string> {
  try {
    const parsed: unknown = JSON.parse(stdin);
    if (!parsed || typeof parsed !== 'object') return '';
    const payload = parsed as Record<string, unknown>;
    const event = text(payload.hook_event_name);
    const sessionId = text(payload.session_id);
    if (sessionId.length === 0) return '';
    const existing = readRecord(env, sessionId);
    const cwd = text(payload.cwd) || existing?.cwd || '';
    const model = text(payload.model) || existing?.model || '';
    const startedAt = existing?.started_at || new Date().toISOString();

    if (event === 'SessionStart') {
      writeRecord(env, { session_id: sessionId, cwd, model, started_at: startedAt, goal: existing?.goal ?? [] });
      return '';
    }
    if (event !== 'UserPromptSubmit') return '';

    const prompt = text(payload.prompt).trim().slice(0, MAX_PROMPT_CHARS);
    if (prompt.length === 0) return '';

    const config = loadConfig(env);
    const line = config.promptGuard
      ? await promptRiskLine(env, config, { cwd, recent: existing?.goal ?? [], prompt })
      : null;

    writeRecord(env, {
      session_id: sessionId,
      cwd,
      model,
      started_at: startedAt,
      goal: [...(existing?.goal ?? []), prompt].slice(-MAX_GOALS),
    });

    if (line === null) return '';
    return JSON.stringify({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: line },
    });
  } catch {
    // never block a session
  }
  return '';
}
