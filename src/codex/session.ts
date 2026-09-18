import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sessionKey, sessionsDir } from '../cache.js';

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

/** SessionStart records the session; UserPromptSubmit keeps the last three prompts. Never throws. */
export async function main(stdin: string, env: NodeJS.ProcessEnv): Promise<string> {
  try {
    const parsed: unknown = JSON.parse(stdin);
    if (!parsed || typeof parsed !== 'object') return '';
    const payload = parsed as Record<string, unknown>;
    const event = text(payload.hook_event_name);
    const sessionId = text(payload.session_id);
    if (sessionId.length === 0) return '';
    const existing = readRecord(env, sessionId);

    if (event === 'SessionStart') {
      writeRecord(env, {
        session_id: sessionId,
        cwd: text(payload.cwd) || existing?.cwd || '',
        model: text(payload.model) || existing?.model || '',
        started_at: existing?.started_at || new Date().toISOString(),
        goal: existing?.goal ?? [],
      });
    } else if (event === 'UserPromptSubmit') {
      const prompt = text(payload.prompt).trim().slice(0, MAX_PROMPT_CHARS);
      if (prompt.length > 0) {
        writeRecord(env, {
          session_id: sessionId,
          cwd: text(payload.cwd) || existing?.cwd || '',
          model: text(payload.model) || existing?.model || '',
          started_at: existing?.started_at || new Date().toISOString(),
          goal: [...(existing?.goal ?? []), prompt].slice(-MAX_GOALS),
        });
      }
    }
  } catch {
    // never block a session
  }
  return '';
}
