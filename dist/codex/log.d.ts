import { type DietConfig } from '../config.js';
/** One JSON line in $PLUGIN_DATA/log/events.jsonl when debug is on. Never throws. */
export declare function appendEvent(env: NodeJS.ProcessEnv, config: DietConfig, event: Record<string, unknown>): void;
