import { describe, expect, it } from 'vitest';
import type { CacheEntry } from '../src/cache.js';
import { chunkQuestions, chunkText, selectChunks } from '../src/chunks.js';
import { DEFAULT_CONFIG, type DietConfig } from '../src/config.js';
import { runDiet, type DietInput } from '../src/codex/diet.js';
import { renderCapsule } from '../src/compressors/index.js';

const config = (over: Partial<DietConfig> = {}): DietConfig => ({ ...DEFAULT_CONFIG, ...over });

const answering = (scores: Record<string, number>) => {
  const calls: string[][] = [];
  return {
    calls,
    asker: {
      async ask(_state: unknown, questions: Record<string, unknown>) {
        const keys = Object.keys(questions);
        calls.push(keys);
        return {
          answers: Object.fromEntries(
            keys.map((key) => [key, { type: 'noul' as const, noul: scores[key] ?? 0.5 }]),
          ),
        };
      },
    },
  };
};

const bigText = 'alpha detail line\n'.repeat(200) + 'omega detail line\n'.repeat(200);

const input = (text: string): DietInput => ({
  toolName: 'Bash', toolUseId: 't1', inputLine: 'npm test', resultText: text, isError: false, goalIndex: 0,
});

const seed: CacheEntry = {
  tool_use_id: 'tool-0', tool_name: 'Read', at: '2026-09-19T00:00:00.000Z', input: 'src/a.ts',
  head: 'digest', tail: '', chars: 20, decision: 'keep', goal_index: 0,
};

const dropScores = {
  needs_contents: 0.05, replaceable: 0.9, keep_call: 0.9, agent_directed: 0.02, behaviour_change: 0.02,
};

describe('chunking', () => {
  it('splits at line boundaries within a budget', () => {
    const text = ['one\ntwo\nthree', 'four\nfive\nsix', 'seven\neight\nnine'].join('\n');
    const chunks = chunkText(text, 3, 14);
    expect(chunks.length).toBeLessThanOrEqual(3);
    for (const chunk of chunks) expect(chunk.text.length).toBeLessThanOrEqual(14);
    expect(chunks.map((chunk) => chunk.index)).toEqual([0, 1, 2].slice(0, chunks.length));
  });

  it('never exceeds the chunk cap', () => {
    expect(chunkText('x\n'.repeat(1000), 4, 10)).toHaveLength(4);
  });

  it('asks one typed question per chunk', () => {
    const questions = chunkQuestions([{ index: 0, text: 'a' }, { index: 1, text: 'b' }]);
    expect(Object.keys(questions)).toEqual(['chunk_1_needed', 'chunk_2_needed']);
    for (const question of Object.values(questions)) {
      expect(question.type).toBe('noul');
      expect(question.criteria?.true).toBeTruthy();
      expect(question.criteria?.false).toBeTruthy();
    }
  });
});

describe('chunk selection', () => {
  const text = 'chunk content line\n'.repeat(200);

  it('keeps strongly needed chunks and drops clearly unnecessary ones', async () => {
    const { asker } = answering({ chunk_1_needed: 0.9, chunk_2_needed: 0.1, chunk_3_needed: 0.1 });
    const outcome = await selectChunks(
      text,
      'goal',
      asker as never,
      config({ chunkMaxChars: 1200, chunkMaxChunks: 3, chunkMaxInclude: 3 }),
    );
    expect(outcome.ids).toEqual([1]);
    expect(outcome.lines.join('\n')).toContain('chunk 1 of 2');
  });

  it('keeps the uncertain band, because uncertainty favours retention', async () => {
    const { asker } = answering({ chunk_1_needed: 0.3, chunk_2_needed: 0.2 });
    const outcome = await selectChunks(text, 'goal', asker as never, config({ chunkMaxChunks: 2 }));
    expect(outcome.ids).toEqual([1]);
  });

  it('prefers the highest scores when the cap bites', async () => {
    const { asker } = answering({
      chunk_1_needed: 0.6, chunk_2_needed: 0.95, chunk_3_needed: 0.7,
    });
    const outcome = await selectChunks(
      text,
      'goal',
      asker as never,
      config({ chunkMaxChars: 1200, chunkMaxChunks: 3, chunkMaxInclude: 1 }),
    );
    expect(outcome.ids).toEqual([2]);
  });

  it('returns nothing rather than guessing when the answers are malformed', async () => {
    const broken = { async ask() { return { answers: {} }; } };
    expect(await selectChunks(text, 'goal', broken as never, config({ chunkMaxChunks: 2 }))).toEqual({ lines: [], ids: [] });
  });

  it('returns nothing when the asker throws', async () => {
    const broken = { async ask() { throw new Error('no network'); } };
    expect(await selectChunks(text, 'goal', broken as never, config({ chunkMaxChunks: 2 }))).toEqual({ lines: [], ids: [] });
  });
});

describe('chunk relevance in the diet path', () => {
  it('adds selected chunks to the capsule for a very large drop', async () => {
    const { asker, calls } = answering({ ...dropScores, chunk_1_needed: 0.9, chunk_2_needed: 0.9, chunk_3_needed: 0.9 });
    const outcome = await runDiet({
      input: input(bigText),
      config: config({ minTokens: 10, chunkMinChars: 1000, chunkMaxChars: 2000, chunkMaxChunks: 3, chunkMaxInclude: 2 }),
      cache: [seed],
      asker: asker as never,
      goal: 'fix it',
      firstResult: false,
    } as never);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.every((key) => key.startsWith('chunk_'))).toBe(true);
    expect(outcome.chunkIds.length).toBeGreaterThan(0);
    expect(String(outcome.note)).toContain('chunk ' + outcome.chunkIds[0] + ' of');
  });

  it('does not ask about chunks for a small result', async () => {
    const { asker, calls } = answering(dropScores);
    await runDiet({
      input: input('small output'),
      config: config({ minTokens: 0, chunkMinChars: 10_000 }),
      cache: [seed],
      asker: asker as never,
      goal: 'fix it',
      firstResult: false,
    } as never);
    expect(calls).toHaveLength(1);
  });

  it('does not ask about chunks when the result is kept', async () => {
    const { asker, calls } = answering({ ...dropScores, needs_contents: 0.9 });
    await runDiet({
      input: input(bigText),
      config: config({ minTokens: 10, chunkMinChars: 1000 }),
      cache: [seed],
      asker: asker as never,
      goal: 'fix it',
      firstResult: false,
    } as never);
    expect(calls).toHaveLength(1);
  });
});

describe('capsule extras', () => {
  const budgets = {
    maxChars: 1200,
    maxErrorLines: 20,
    maxStackFrames: 10,
    maxSummaryLines: 8,
    headChars: 300,
  };

  it('shows selected chunks', () => {
    const found = renderCapsule(
      { toolName: 'Bash', inputLine: 'npm test', resultText: 'plain output\n'.repeat(100), isError: false },
      budgets,
      ['chunk 1 of 2:\nselected detail marker'],
    );
    expect(found.text).toContain('selected detail marker');
  });

  it('gives up chunk extras before deterministic evidence', () => {
    const text = ['FAIL tests/a.test.ts', 'AssertionError: expected 1 to be 2', 'at tests/a.test.ts:9:1', 'noise\n'.repeat(50)].join('\n');
    const found = renderCapsule(
      { toolName: 'Bash', inputLine: 'npm test', resultText: text, isError: false },
      { ...budgets, maxChars: 600 },
      ['chunk 1 of 2:\n' + 'z'.repeat(2000)],
    );
    expect(found.text).toContain('AssertionError');
    expect(found.text.length).toBeLessThanOrEqual(600);
  });

  it('retains a chunk that sits exactly on the drop threshold', async () => {
    const exact = answering({ chunk_1_needed: DEFAULT_CONFIG.dropThreshold, chunk_2_needed: 0.0 });
    const kept = await selectChunks(bigText, 'goal', exact.asker as never, config({ chunkMaxChunks: 2, chunkMaxInclude: 2 }));
    expect(kept.ids).toContain(1);
    expect(kept.ids).not.toContain(2);
  });

  it('keeps the deterministic capsule when there is no asker', async () => {
    // The diet questions are answered, the chunk questions are not: the drop
    // still happens and the deterministic capsule survives untouched.
    const asker = {
      async ask(_state: unknown, questions: Record<string, unknown>) {
        const keys = Object.keys(questions);
        if (keys.some((key) => key.startsWith('chunk_'))) throw new Error('chunk transport failed');
        return {
          answers: Object.fromEntries(
            keys.map((key) => [key, { type: 'noul' as const, noul: (dropScores as Record<string, number>)[key] ?? 0.5 }]),
          ),
        };
      },
    };
    const outcome = await runDiet({
      input: input(bigText),
      config: config({ minTokens: 10, chunkMinChars: 1000, chunkMaxChars: 2000, chunkMaxChunks: 3 }),
      cache: [seed],
      asker: asker as never,
      goal: 'fix it',
      firstResult: false,
    } as never);
    expect(outcome.decision.action).toBe('drop_result');
    expect(outcome.chunkIds).toEqual([]);
    expect(String(outcome.note)).toContain('[codex-context-diet evidence]');
  });
});
