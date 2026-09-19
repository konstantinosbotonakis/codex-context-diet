import { type DietConfig } from '../config.js';
/**
 * Context resurrection around compaction.
 *
 * `PreCompact` can only write state, and `PostCompact` can only surface a
 * message to the user, so the snapshot is injected where model context is
 * supported: the next `UserPromptSubmit`, once. Everything here fails open and
 * nothing here reads the transcript.
 */
export declare const RESURRECTION_HEADER = "[codex-context-diet resurrection]";
export declare function resurrectionPath(env: NodeJS.ProcessEnv, sessionId: string): string;
/** A compact, bounded picture of what the session was doing. No raw results. */
export declare function buildSnapshot(env: NodeJS.ProcessEnv, sessionId: string, config: DietConfig): string;
/** PreCompact writes the snapshot, PostCompact records that it happened. Never throws. */
export declare function handleCompaction(payload: Record<string, unknown>, env: NodeJS.ProcessEnv): Promise<string>;
export declare function takeResurrection(env: NodeJS.ProcessEnv, sessionId: string, config: DietConfig): string | null;
