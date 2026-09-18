import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pluginDataDir, type DietConfig } from '../config.js';

/** One JSON line in $PLUGIN_DATA/log/events.jsonl when debug is on. Never throws. */
export function appendEvent(
  env: NodeJS.ProcessEnv,
  config: DietConfig,
  event: Record<string, unknown>,
): void {
  if (!config.debug) return;
  try {
    const dir = join(pluginDataDir(env), 'log');
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'events.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n');
  } catch {
    // diagnostics never break a run
  }
}
