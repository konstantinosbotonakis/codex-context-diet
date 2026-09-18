import { buildJevRequest, parseJevResponse } from '../request.js';
import type { DietConfig } from '../config.js';
import type { JevAsker, JevQuestions, JevResponse } from '../types.js';

/** Deterministic asker for tests and offline runs. '*' is the fallback score. */
export function testAsker(spec: string | Record<string, number>): JevAsker {
  const scores = typeof spec === 'string' ? (JSON.parse(spec) as Record<string, number>) : spec;
  const scoreOf = (key: string): number => {
    const value = scores[key] ?? scores['*'];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error('testAsker has no score for ' + key);
    }
    return value;
  };
  return {
    async ask(_state, questions: JevQuestions): Promise<JevResponse> {
      return {
        answers: Object.fromEntries(
          Object.keys(questions).map((key) => [
            key,
            { type: 'noul' as const, noul: scoreOf(key) },
          ]),
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
