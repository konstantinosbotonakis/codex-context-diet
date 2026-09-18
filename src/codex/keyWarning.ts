import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pluginDataDir } from '../config.js';

export type KeyProblem = 'missing' | 'rejected';

const MESSAGES: Record<KeyProblem, string> = {
  missing:
    'Context Diet: no TypeSafe API key found, so Jev was not used and tool results were kept in full. ' +
    'Set TYPESAFE_API_KEY or write the key to ~/.typesafe_key.',
  rejected:
    'Context Diet: TypeSafe rejected the API key, so Jev was not used and tool results were kept in full. ' +
    'Check the key, then update ~/.typesafe_key or TYPESAFE_API_KEY.',
};

export function keyWarningMessage(problem: KeyProblem): string {
  return MESSAGES[problem];
}

/** Pulls the HTTP status out of a transport error, so a rejected key can be named. */
export function problemFromError(message: string): KeyProblem | null {
  return /\(401\)|\(403\)/.test(message) ? 'rejected' : null;
}

/**
 * At most one warning per session, and never more than once an hour, so a
 * missing key does not turn every tool call into a notification.
 */
export function keyWarning(
  env: NodeJS.ProcessEnv,
  sessionId: string,
  problem: KeyProblem,
  now = new Date(),
): string | null {
  const path = join(pluginDataDir(env), 'state', 'key-warning.json');
  try {
    const previous = JSON.parse(readFileSync(path, 'utf8')) as { session_id?: string; at?: string };
    if (previous.session_id === sessionId) return null;
    const at = previous.at ? Date.parse(previous.at) : Number.NaN;
    if (Number.isFinite(at) && now.getTime() - at < 60 * 60 * 1000) return null;
  } catch {
    // no record yet
  }
  try {
    mkdirSync(join(pluginDataDir(env), 'state'), { recursive: true });
    writeFileSync(path, JSON.stringify({ session_id: sessionId, problem, at: now.toISOString() }) + '\n');
  } catch {
    // best effort: a failed write costs one extra warning, never a broken run
  }
  return MESSAGES[problem];
}
