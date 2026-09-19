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
    /** Why the decision went the way it did, so a later rerun can be scored. */
    reason?: string;
    /** The Jev scores that produced the decision, bounded to four numbers. */
    scores?: {
        keepCall: number;
        needsContents: number;
        replaceable: number;
        injection: number | null;
    };
    /** Ordinal of this call within the session, as the cache counted it. */
    callIndex?: number;
    /** What the model actually kept for this call, when it differs from chars. */
    keptChars?: number;
}
export interface TouchRecord {
    at: string;
    tool: string;
    /** Paths this call could have written; `*` means unknown, treat everything as dirty. */
    paths: string[];
}
export interface RecoveryRecord {
    /** tool_use_id of the dropped result this call appears to be re-running. */
    of: string;
    /** Key for the tool and input, so one input scores a recovery once. */
    inputHash: string;
    at: string;
    tool: string;
    afterMs: number;
    afterCalls: number;
    /** The command or path that was re-run, bounded, for the snapshot. */
    input?: string;
    /** Characters the original result carried, for the recovery cost estimate. */
    chars?: number;
    /** likely_recovery, possible_rerun or invalidated_rerun. Absent on older records. */
    classification?: string;
    /** One line explaining the classification. */
    because?: string;
}
/** Session ids come from the host, so a hostile one must not escape the data directory. */
export declare function sessionKey(sessionId: string): string;
export declare function sessionsDir(env: NodeJS.ProcessEnv): string;
export declare function cachePath(env: NodeJS.ProcessEnv, sessionId: string): string;
export declare function touchPath(env: NodeJS.ProcessEnv, sessionId: string): string;
export declare function appendTouch(env: NodeJS.ProcessEnv, sessionId: string, touch: TouchRecord, limit?: number): void;
export declare function readTouches(env: NodeJS.ProcessEnv, sessionId: string): TouchRecord[];
export declare function recoveryPath(env: NodeJS.ProcessEnv, sessionId: string): string;
export declare function appendRecovery(env: NodeJS.ProcessEnv, sessionId: string, recovery: RecoveryRecord, limit?: number): void;
export declare function readRecoveries(env: NodeJS.ProcessEnv, sessionId: string): RecoveryRecord[];
/** Newest first in the file, oldest first here. A corrupt line costs one entry, never the run. */
export declare function readCache(env: NodeJS.ProcessEnv, sessionId: string, config?: DietConfig): CacheEntry[];
export declare function appendCache(env: NodeJS.ProcessEnv, sessionId: string, entry: CacheEntry, config: DietConfig): void;
export declare function countSessions(env: NodeJS.ProcessEnv): number;
