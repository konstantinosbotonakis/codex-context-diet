import { type DietConfig } from '../config.js';
export declare function logPath(env: NodeJS.ProcessEnv): string;
/** Local date, YYYY-MM-DD. Rotation is a daily event, and local is what a user means by a day. */
export declare function dayKey(date: Date): string;
/**
 * Drops events older than logRetentionDays. Runs at most once a day, tracked by
 * a marker file, so the usual append stays a single small write.
 */
export declare function rotateLog(env: NodeJS.ProcessEnv, config: DietConfig, now?: Date): boolean;
/** One JSON line in $PLUGIN_DATA/log/events.jsonl when debug is on. Never throws. */
export declare function appendEvent(env: NodeJS.ProcessEnv, config: DietConfig, event: Record<string, unknown>): void;
