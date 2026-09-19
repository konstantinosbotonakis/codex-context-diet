import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readCache, readRecoveries, readTouches, sessionKey } from '../cache.js';
import { loadConfig, pluginDataDir, type DietConfig } from '../config.js';
import { appendEvent } from './log.js';
import { readGoal } from './session.js';

/**
 * Context resurrection around compaction.
 *
 * `PreCompact` can only write state, and `PostCompact` can only surface a
 * message to the user, so the snapshot is injected where model context is
 * supported: the next `UserPromptSubmit`, once. Everything here fails open and
 * nothing here reads the transcript.
 */
export const RESURRECTION_HEADER = '[codex-context-diet resurrection]';

const clip = (text: string, limit: number): string => (text.length <= limit ? text : text.slice(0, limit));
const text = (value: unknown): string => (typeof value === 'string' ? value : '');

export function resurrectionPath(env: NodeJS.ProcessEnv, sessionId: string): string {
  return join(pluginDataDir(env), 'state', 'resurrection-' + sessionKey(sessionId) + '.md');
}

/** A compact, bounded picture of what the session was doing. No raw results. */
export function buildSnapshot(env: NodeJS.ProcessEnv, sessionId: string, config: DietConfig): string {
  const lines: string[] = [RESURRECTION_HEADER];
  const { goal } = readGoal(env, sessionId);
  if (goal.trim().length > 0) lines.push('Goal: ' + clip(goal.replace(/\n/g, ' / '), 300));
  const files = [...new Set(readTouches(env, sessionId).flatMap((touch) => touch.paths))]
    .filter((path) => path !== '*')
    .slice(-8);
  if (files.length > 0) lines.push('Files written: ' + files.join(', '));
  const cache = readCache(env, sessionId, config);
  const removed = cache.filter((entry) => entry.decision === 'drop_result').slice(-8);
  if (removed.length > 0) {
    lines.push('Outputs removed, re-run to see them again:');
    for (const entry of removed) {
      lines.push('- ' + clip(entry.tool_name + ' ' + entry.input, 120) + ' (' + entry.chars + ' chars, ' + (entry.reason ?? 'dropped') + ')');
    }
  }
  const decisions = cache.slice(-6);
  if (decisions.length > 0) {
    lines.push('Recent decisions:');
    for (const entry of decisions) {
      lines.push('- ' + clip(entry.tool_name + ' ' + entry.input, 100) + ' -> ' + (entry.decision === 'drop_result' ? 'dropped' : 'kept'));
    }
  }
  const recoveries = readRecoveries(env, sessionId).slice(-4);
  if (recoveries.length > 0) {
    lines.push('Re-runs of dropped output:');
    for (const record of recoveries) {
      lines.push('- ' + clip(record.tool + ' ' + (record.input ?? ''), 120));
    }
  }
  const snapshot = lines.join('\n');
  // A header with nothing under it is noise, not continuity.
  if (lines.length === 1) return '';
  return snapshot.length <= config.snapshotMaxChars ? snapshot : snapshot.slice(0, config.snapshotMaxChars);
}

/** PreCompact writes the snapshot, PostCompact records that it happened. Never throws. */
export async function handleCompaction(payload: Record<string, unknown>, env: NodeJS.ProcessEnv): Promise<string> {
  try {
    const config = loadConfig(env);
    if (!config.compactionResurrection) return '';
    const event = text(payload.hook_event_name);
    const sessionId = text(payload.session_id);
    const trigger = text(payload.trigger);
    if (event === 'PreCompact') {
      const snapshot = buildSnapshot(env, sessionId, config);
      try {
        mkdirSync(join(pluginDataDir(env), 'state'), { recursive: true });
        writeFileSync(resurrectionPath(env, sessionId), snapshot + '\n');
      } catch {
        // best effort: a lost snapshot costs continuity, never correctness
      }
      appendEvent(env, config, { kind: 'compaction', phase: 'pre', trigger, chars: snapshot.length });
      return '';
    }
    if (event === 'PostCompact') {
      appendEvent(env, config, { kind: 'compaction', phase: 'post', trigger });
      return '';
    }
    return '';
  } catch {
    return '';
  }
}

export function takeResurrection(env: NodeJS.ProcessEnv, sessionId: string, config: DietConfig): string | null {
  if (!config.compactionResurrection) return null;
  const path = resurrectionPath(env, sessionId);
  try {
    const snapshot = readFileSync(path, 'utf8').trim();
    if (snapshot.length === 0) return null;
    writeFileSync(path, '');
    return snapshot;
  } catch {
    return null;
  }
}
