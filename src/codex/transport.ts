import { buildJevRequest, parseJevResponse } from '../request.js';
import type { DietConfig } from '../config.js';
import type { JevAnswer, JevAsker, JevQuestions, JevResponse } from '../types.js';

type TestAnswer =
  | number
  | { noul?: number; choice?: string; score?: number; confidence?: number; probabilities?: Record<string, number> };

/** Deterministic asker for tests and offline runs. '*' is the fallback score. */
export function testAsker(spec: string | Record<string, TestAnswer>): JevAsker {
  const scores = typeof spec === 'string' ? (JSON.parse(spec) as Record<string, TestAnswer>) : spec;
  const answerOf = (key: string): JevAnswer => {
    const value = scores[key] ?? scores['*'];
    if (typeof value === 'number' && Number.isFinite(value)) return { type: 'noul', noul: value };
    if (value && typeof value === 'object') {
      if (typeof value.choice === 'string') {
        return {
          type: 'choice',
          choice: value.choice,
          confidence: value.confidence ?? 1,
          probabilities: value.probabilities ?? {},
        };
      }
      if (typeof value.score === 'number' && Number.isFinite(value.score)) {
        return {
          type: 'score',
          score: value.score,
          confidence: value.confidence ?? 1,
          probabilities: value.probabilities ?? {},
        };
      }
      if (typeof value.noul === 'number' && Number.isFinite(value.noul)) return { type: 'noul', noul: value.noul };
    }
    throw new Error('testAsker has no score for ' + key);
  };
  return {
    async ask(_state, questions: JevQuestions): Promise<JevResponse> {
      return {
        answers: Object.fromEntries(
          Object.keys(questions).map((key) => [key, answerOf(key)]),
        ),
      };
    },
  };
}

/** The real asker: one POST, hard deadline, no retries. */
export function createAsker(config: DietConfig, key: string, env: NodeJS.ProcessEnv): JevAsker {
  const injected = env.CONTEXT_DIET_TEST_ANSWERS;
  if (injected) return testAsker(injected);
  return {
    async ask(state, questions) {
      const request = buildJevRequest({ apiKey: key, model: config.model }, state, questions);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);
      try {
        const response = await fetch(request.url, {
          method: request.method,
          headers: request.headers,
          body: request.body,
          signal: controller.signal,
        });
        return parseJevResponse(response.status, response.ok, await response.text());
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
