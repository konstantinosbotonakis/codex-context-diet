import type { DietConfig } from '../config.js';
import type { JevAsker } from '../types.js';
/** Deterministic asker for tests and offline runs. '*' is the fallback score. */
export declare function testAsker(spec: string | Record<string, number>): JevAsker;
/** The real asker: one POST, hard deadline, no retries. */
export declare function createAsker(config: DietConfig, key: string, env: NodeJS.ProcessEnv): JevAsker;
