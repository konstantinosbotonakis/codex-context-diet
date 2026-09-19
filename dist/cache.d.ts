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
    /** sha256 of the normalised result, used to prove a duplicate deterministically. */
    hash?: string;
    /** File path for read-class results, so a later write can invalidate them. */
    resource?: string;
}
export interface TouchRecord {
    at: string;
    tool: string;
    /** Paths this call could have written; `*` means unknown, treat everything as dirty. */
    paths: string[];
}
/** Session ids come from the host, so a hostile one must not escape the data directory. */
export declare function sessionKey(sessionId: string): string;
export declare function sessionsDir(env: NodeJS.ProcessEnv): string;
export declare function cachePath(env: NodeJS.ProcessEnv, sessionId: string): string;
export declare function touchPath(env: NodeJS.ProcessEnv, sessionId: string): string;
export declare function appendTouch(env: NodeJS.ProcessEnv, sessionId: string, touch: TouchRecord, limit?: number): void;
export declare function readTouches(env: NodeJS.ProcessEnv, sessionId: string): TouchRecord[];
/** Newest first in the file, oldest first here. A corrupt line costs one entry, never the run. */
export declare function readCache(env: NodeJS.ProcessEnv, sessionId: string, config?: DietConfig): CacheEntry[];
export declare function appendCache(env: NodeJS.ProcessEnv, sessionId: string, entry: CacheEntry, config: DietConfig): void;
export declare function countSessions(env: NodeJS.ProcessEnv): number;
