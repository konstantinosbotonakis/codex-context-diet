import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DietConfig } from './config.js';

export type KeySource = 'env' | 'file' | 'config' | 'none';

export function keyFilePath(env: NodeJS.ProcessEnv): string {
  return env.TYPESAFE_KEY_FILE ?? join(env.HOME ?? '.', '.typesafe_key');
}

function readKeyFile(path: string): string | null {
  try {
    const first = readFileSync(path, 'utf8').split('\n')[0]?.trim() ?? '';
    return first.length > 0 ? first : null;
  } catch {
    return null;
  }
}

/** env -> ~/.typesafe_key -> config. The key value goes to the caller and nowhere else. */
export function resolveApiKey(
  config: DietConfig,
  env: NodeJS.ProcessEnv,
): { key: string | null; source: KeySource } {
  const fromEnv = (env.TYPESAFE_API_KEY ?? '').trim();
  if (fromEnv) return { key: fromEnv, source: 'env' };
  const fromFile = readKeyFile(keyFilePath(env));
  if (fromFile) return { key: fromFile, source: 'file' };
  if (config.apiKey) return { key: config.apiKey, source: 'config' };
  return { key: null, source: 'none' };
}
