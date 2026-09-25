import type { DietConfig } from '../config.js';
import type { JevAsker } from '../types.js';
type TestAnswer = number | {
    noul?: number;
    choice?: string;
    score?: number;
    confidence?: number;
    probabilities?: Record<string, number>;
};
/** Deterministic asker for tests and offline runs. '*' is the fallback score. */
export declare function testAsker(spec: string | Record<string, TestAnswer>): JevAsker;
/** Credentials belong to the hosted provider; local and test transports need none. */
export declare function configuredAsker(config: DietConfig, env: NodeJS.ProcessEnv): JevAsker | null;
/** The real asker: one POST, hard deadline, no retries. */
export declare function createAsker(config: DietConfig, key: string, env: NodeJS.ProcessEnv): JevAsker;
export {};
