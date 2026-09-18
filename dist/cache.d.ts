import { type DietConfig } from './config.js';
export interface CacheEntry {
    tool_use_id: string;
    tool_name: string;
    at: string;
    input: string;
    head: string;
    tail: string;
    chars: number;
    decision: string;
    goal_index: number;
}
/** Session ids come from the host, so a hostile one must not escape the data directory. */
export declare function sessionKey(sessionId: string): string;
export declare function sessionsDir(env: NodeJS.ProcessEnv): string;
export declare function cachePath(env: NodeJS.ProcessEnv, sessionId: string): string;
/** Newest first in the file, oldest first here. A corrupt line costs one entry, never the run. */
export declare function readCache(env: NodeJS.ProcessEnv, sessionId: string, config?: DietConfig): CacheEntry[];
export declare function appendCache(env: NodeJS.ProcessEnv, sessionId: string, entry: CacheEntry, config: DietConfig): void;
export declare function countSessions(env: NodeJS.ProcessEnv): number;
