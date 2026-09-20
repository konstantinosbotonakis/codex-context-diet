export const SYSTEM_ONE_URL = 'https://api.typesafe.ai/v1/systemone';
export const DEFAULT_MODEL = 'jev-latest';
/** The HTTP request for one Jev call, for any fetch-like transport. */
export function buildJevRequest(params, state, questions) {
    return {
        url: params.baseUrl ?? SYSTEM_ONE_URL,
        method: 'POST',
        headers: {
            authorization: `Bearer ${params.apiKey}`,
            'content-type': 'application/json',
        },
        body: JSON.stringify({
            model: params.model ?? DEFAULT_MODEL,
            state,
            questions,
        }),
    };
}
/** Validates a Jev response body; throws on anything but an `answers` object. */
export function parseJevResponse(status, ok, text) {
    if (!ok) {
        throw new Error(`Jev request failed (${status}): ${text.slice(0, 200)}`);
    }
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch {
        throw new Error('Jev returned malformed JSON');
    }
    if (parsed === null ||
        typeof parsed !== 'object' ||
        !('answers' in parsed) ||
        parsed.answers === null ||
        typeof parsed.answers !== 'object') {
        throw new Error('Jev response is missing answers');
    }
    return normaliseAnswers(parsed);
}
/**
 * Score answers arrive keyed by level index, with the labels in a legend
 * beside them ("0": "quiet"). Callers reason in labels, so the distribution is
 * re-keyed from the legend when it is present and left untouched when it is
 * not. Live jev-1.13 answers carry the legend; a fake asker need not.
 */
function normaliseScoreAnswer(answer) {
    if (answer.type !== 'score')
        return answer;
    const legend = answer.legend;
    const probabilities = answer.probabilities;
    if (legend === undefined || probabilities === undefined)
        return answer;
    const relabelled = {};
    for (const [key, value] of Object.entries(probabilities)) {
        relabelled[legend[key] ?? key] = value;
    }
    return { ...answer, probabilities: relabelled };
}
/** One pass over the answers, so every consumer reads the same shape. */
function normaliseAnswers(response) {
    const answers = {};
    for (const [id, answer] of Object.entries(response.answers)) {
        answers[id] = normaliseScoreAnswer(answer);
    }
    return { ...response, answers };
}
/** The input-token count the API reports for a call, or null when it is absent. */
export function inputTokensOf(response) {
    const value = response.usage?.input_tokens;
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
/** The `noul` probability of one answer; throws when it is not there. */
export function noulAnswer(answers, name) {
    const answer = answers[name];
    if (!answer ||
        !('noul' in answer) ||
        typeof answer.noul !== 'number' ||
        !Number.isFinite(answer.noul)) {
        throw new Error(`Invalid Jev answer for ${name}`);
    }
    return answer.noul;
}
//# sourceMappingURL=request.js.map