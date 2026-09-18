import type { DietConfig } from './config.js';
export type KeySource = 'env' | 'file' | 'config' | 'none';
export declare function keyFilePath(env: NodeJS.ProcessEnv): string;
/** env -> ~/.typesafe_key -> config. The key value goes to the caller and nowhere else. */
export declare function resolveApiKey(config: DietConfig, env: NodeJS.ProcessEnv): {
    key: string | null;
    source: KeySource;
};
