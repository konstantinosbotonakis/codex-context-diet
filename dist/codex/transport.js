import { buildJevRequest, parseJevResponse } from '../request.js';
import { createLayaAsker } from '../providers/laya.js';
/** Deterministic asker for tests and offline runs. '*' is the fallback score. */
export function testAsker(spec) {
    const scores = typeof spec === 'string' ? JSON.parse(spec) : spec;
    const answerOf = (key) => {
        const value = scores[key] ?? scores['*'];
        if (typeof value === 'number' && Number.isFinite(value))
            return { type: 'noul', noul: value };
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
            if (typeof value.noul === 'number' && Number.isFinite(value.noul))
                return { type: 'noul', noul: value.noul };
        }
        throw new Error('testAsker has no score for ' + key);
    };
    return {
        async ask(_state, questions) {
            return {
                answers: Object.fromEntries(Object.keys(questions).map((key) => [key, answerOf(key)])),
            };
        },
    };
}
/** The real asker: one POST, hard deadline, no retries. */
export function createAsker(config, key, env) {
    const injected = env.CONTEXT_DIET_TEST_ANSWERS;
    if (injected)
        return testAsker(injected);
    // A local Laya checkpoint answers the same questions with no key and no network.
    if (config.provider === 'laya')
        return createLayaAsker(config, env);
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
            }
            finally {
                clearTimeout(timer);
            }
        },
    };
}
//# sourceMappingURL=transport.js.map