import { describe, expect, it } from 'vitest';
import type { CacheEntry } from '../src/cache.js';
import { buildDietState } from '../src/dietState.js';
import {
  dietQuestions, Q_AGENT_DIRECTED, Q_BEHAVIOUR_CHANGE, Q_KEEP_CALL, Q_NEEDS_CONTENTS, Q_REPLACEABLE,
} from '../src/questions.js';

const entry = (n: number): CacheEntry => ({
  tool_use_id: 'tool-' + n, tool_name: 'Bash', at: '2026-09-18T00:00:00.000Z',
  input: 'npm test -- ' + n, head: 'digest ' + n, tail: 'tail', chars: 900 + n,
  decision: 'keep', goal_index: 0,
});

const input = {
  goal: 'fix the failing test',
  history: [entry(1), entry(2), entry(3)],
  toolName: 'Bash',
  inputLine: 'npm run build',
  resultText: 'build line here\n'.repeat(100),
};

describe('questions', () => {
  it('asks two questions, or three with the guard on', () => {
    const two = dietQuestions({ tool: 'Bash', inputLine: 'npm test', resultChars: 10 }, false);
    const three = dietQuestions({ tool: 'Bash', inputLine: 'npm test', resultChars: 10 }, true);
    expect(Object.keys(two)).toEqual([Q_NEEDS_CONTENTS, Q_REPLACEABLE, Q_KEEP_CALL]);
    expect(Object.keys(three)).toEqual([
      Q_NEEDS_CONTENTS, Q_REPLACEABLE, Q_KEEP_CALL, Q_AGENT_DIRECTED, Q_BEHAVIOUR_CHANGE,
    ]);
    for (const question of Object.values(three)) {
      expect(question.type).toBe('noul');
      expect(question.instructions.length).toBeGreaterThan(20);
    }
  });
});

describe('diet state', () => {
  it('keeps the goal, the digests and the current result when everything fits', () => {
    const fitted = buildDietState(input, { maxStateTokens: 25_000, resultCapChars: 4000 });
    expect(fitted.stage).toBe('full');
    const json = JSON.stringify(fitted.state);
    expect(json).toContain('fix the failing test');
    expect(json).toContain('t1 Bash');
    expect(json).toContain('digest 1');
    expect(json).toContain('npm run build');
    expect(fitted.tokens).toBeGreaterThan(0);
  });

  it('caps the current result but reports its true length', () => {
    const fitted = buildDietState({ ...input, resultText: 'z'.repeat(10_000) }, {
      maxStateTokens: 25_000, resultCapChars: 500,
    });
    expect(fitted.state.current.result.length).toBeLessThanOrEqual(500);
    expect(fitted.state.current.resultChars).toBe(10_000);
  });

  it('walks through distinct shrink stages as the budget falls', () => {
    const big = { ...input, resultText: 'q'.repeat(20_000) };
    const stages: string[] = [];
    for (const budget of [8000, 4000, 2000, 1000, 700, 500, 400, 320, 260]) {
      try {
        stages.push(buildDietState(big, { maxStateTokens: budget, resultCapChars: 4000 }).stage);
      } catch {
        break;
      }
    }
    expect(new Set(stages).size).toBeGreaterThanOrEqual(3);
  });

  it('throws rather than mangle a result it cannot fit', () => {
    expect(() =>
      buildDietState({ ...input, resultText: 'r'.repeat(20_000) }, {
        maxStateTokens: 20, resultCapChars: 4000,
      }),
    ).toThrow(/too large/);
  });
});
