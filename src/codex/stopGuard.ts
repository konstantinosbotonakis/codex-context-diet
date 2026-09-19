import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readRecoveries } from '../cache.js';
import { pluginDataDir } from '../config.js';

const RECOVERY_WINDOW_MS = 15 * 60 * 1000;
const RECOVERY_WARN_AT = 2;

/**
 * Report once per session when several dropped results were re-run recently.
 *
 * The MCP `stop_guard` tool and the command fallback both call this, so the
 * two transports cannot drift. Returns the stdout body, or an empty string
 * when there is nothing to say.
 */
export function handleStopGuard(payload: Record<string, unknown>, env: NodeJS.ProcessEnv): string {
  const sessionId = typeof payload.session_id === 'string' ? payload.session_id : '';
  const recent = readRecoveries(env, sessionId).filter((record) => {
    const at = Date.parse(record.at);
    return Number.isFinite(at) && Date.now() - at <= RECOVERY_WINDOW_MS;
  });
  if (recent.length < RECOVERY_WARN_AT) return '';
  const marker = join(pluginDataDir(env), 'state', 'stop-guard.json');
  try {
    const previous = JSON.parse(readFileSync(marker, 'utf8')) as { session_id?: string };
    if (previous.session_id === sessionId) return '';
  } catch {
    // no marker yet
  }
  try {
    mkdirSync(join(pluginDataDir(env), 'state'), { recursive: true });
    writeFileSync(marker, JSON.stringify({ session_id: sessionId, at: new Date().toISOString() }) + '\n');
  } catch {
    // best effort
  }
  return JSON.stringify({
    systemMessage:
      '[codex-context-diet] ' + recent.length + ' dropped results were re-run in the last 15 minutes. ' +
      'Consider a higher minTokens or a tool policy for the commands involved.',
  });
}

