import type { DietConfig } from './config.js';
import { noulAnswer } from './request.js';
import { sampleResult } from './sample.js';
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

export const CHUNK_CONTEXT =
  'A very large tool result was split into numbered chunks. Each question asks whether one chunk ' +
  'still matters for the work ahead. A chunk matters when it carries evidence, results, ' +
  'identifiers or instructions for the current task, and does not when it is repetition or noise.';

export function chunkText(text: string, maxChunks: number, chunkChars: number): Chunk[] {
  const chunks: Chunk[] = [];
  let offset = 0;
  const size = Math.max(1, Math.floor(chunkChars));
  while (offset < text.length && chunks.length < maxChunks) {
    let end = Math.min(offset + size, text.length);
    if (end < text.length) {
      const newline = text.lastIndexOf('\n', end);
      if (newline > offset + Math.floor(size / 2)) end = newline + 1;
    }
    chunks.push({ index: chunks.length, text: text.slice(offset, end) });
    offset = end;
  }
  return chunks;
}

export function chunkQuestions(chunks: Chunk[]): JevQuestions {
  return Object.fromEntries(
    chunks.map((chunk) => [
      'chunk_' + (chunk.index + 1) + '_needed',
      {
        type: 'noul' as const,
        instructions:
          'Does chunk ' + (chunk.index + 1) + ' of ' + chunks.length +
          ' contain information the assistant still needs for the work ahead?',
        criteria: {
          true: 'It carries evidence, results, identifiers or instructions that matter for the task',
          false: 'It is repetition, noise or detail that can be dropped without losing meaning',
        },
      },
    ]),
  );
}

export interface ChunkOutcome {
  /** Capsule lines for the selected chunks, in original order. */
  lines: string[];
  /** One-based chunk numbers that were selected, for the debug log. */
  ids: number[];
}

const EMPTY: ChunkOutcome = { lines: [], ids: [] };

export async function selectChunks(
  text: string,
  goal: string,
  asker: JevAsker,
  config: DietConfig,
): Promise<ChunkOutcome> {
  const budget = Math.max(2000, Math.min(config.chunkMaxChars, config.maxStateTokens * 3));
  const sample = sampleResult(text, {
    budgetChars: budget,
    headChars: Math.floor(budget / 3),
    tailChars: Math.floor(budget / 6),
  });
  const chunks = chunkText(
    sample.text,
    config.chunkMaxChunks,
    Math.max(200, Math.floor(budget / Math.max(1, config.chunkMaxChunks))),
  );
  if (chunks.length === 0) return EMPTY;
  try {
    const response = await asker.ask(
      { context: CHUNK_CONTEXT, goal, chunks: chunks.map((chunk) => ({ i: chunk.index + 1, text: chunk.text })) },
      chunkQuestions(chunks),
    );
    const scored = chunks.map((chunk) => ({
      chunk,
      score: noulAnswer(response.answers, 'chunk_' + (chunk.index + 1) + '_needed'),
    }));
    // Only a clearly unnecessary chunk is dropped, so the uncertain band is
    // retained, and the cap prefers the chunks Jev scored highest.
    const kept = scored.filter((item) => item.score >= config.dropThreshold);
    kept.sort((left, right) => right.score - left.score || left.chunk.index - right.chunk.index);
    const chosen = kept.slice(0, config.chunkMaxInclude);
    chosen.sort((left, right) => left.chunk.index - right.chunk.index);
    return {
      lines: chosen.map((item) => 'chunk ' + (item.chunk.index + 1) + ' of ' + chunks.length + ':\n' + item.chunk.text),
      ids: chosen.map((item) => item.chunk.index + 1),
    };
  } catch {
    // Enrichment is best effort. A failed chunk request leaves the
    // deterministic capsule, and the main decision, untouched.
    return EMPTY;
  }
}

