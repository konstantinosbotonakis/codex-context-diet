import type { DietConfig } from './config.js';
import type { JevAsker, JevQuestions } from './types.js';
/**
 * Semantic chunk selection for exceptionally large results.
 *
 * The result is sampled to a bounded size first, split into bounded chunks,
 * and judged in a single request with one yes/no question per chunk. The
 * answers only enrich the evidence capsule: they never change the keep or drop
 * decision, which stays with the deterministic policy on the sampled state.
 */
export interface Chunk {
    index: number;
    text: string;
}
export declare const CHUNK_CONTEXT: string;
export declare function chunkText(text: string, maxChunks: number, chunkChars: number): Chunk[];
export declare function chunkQuestions(chunks: Chunk[]): JevQuestions;
export interface ChunkOutcome {
    /** Capsule lines for the selected chunks, in original order. */
    lines: string[];
    /** One-based chunk numbers that were selected, for the debug log. */
    ids: number[];
}
export declare function selectChunks(text: string, goal: string, asker: JevAsker, config: DietConfig): Promise<ChunkOutcome>;
