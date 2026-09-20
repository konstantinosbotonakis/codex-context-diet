import type { JevAnswer, JevQuestions, JevResponse, JevState } from './types.js';

export const SYSTEM_ONE_URL = 'https://api.typesafe.ai/v1/systemone';
export const DEFAULT_MODEL = 'jev-latest';

export interface JevRequest {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: string;
}

/** The HTTP request for one Jev call, for any fetch-like transport. */
export function buildJevRequest(
  params: {
    apiKey: string;
    model?: string;
    baseUrl?: string;
  },
  state: JevState,
  questions: JevQuestions,
): JevRequest {
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
export function parseJevResponse(
  status: number,
  ok: boolean,
  text: string,
): JevResponse {
  if (!ok) {
    throw new Error(`Jev request failed (${status}): ${text.slice(0, 200)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Jev returned malformed JSON');
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    !('answers' in parsed) ||
    parsed.answers === null ||
    typeof parsed.answers !== 'object'
  ) {
    throw new Error('Jev response is missing answers');
  }
  return normaliseAnswers(parsed as JevResponse);
}

/**
 * Score answers arrive keyed by level index, with the labels in a legend
 * beside them ("0": "quiet"). Callers reason in labels, so the distribution is
 * re-keyed from the legend when it is present and left untouched when it is
 * not. Live jev-1.13 answers carry the legend; a fake asker need not.
 */
function normaliseScoreAnswer(answer: JevAnswer): JevAnswer {
  if (answer.type !== 'score') return answer;
  const legend = answer.legend;
  const probabilities = answer.probabilities;
  if (legend === undefined || probabilities === undefined) return answer;
  const relabelled: Record<string, number> = {};
  for (const [key, value] of Object.entries(probabilities)) {
    relabelled[legend[key] ?? key] = value;
  }
  return { ...answer, probabilities: relabelled };
}

/** One pass over the answers, so every consumer reads the same shape. */
function normaliseAnswers(response: JevResponse): JevResponse {
  const answers: Record<string, JevAnswer> = {};
  for (const [id, answer] of Object.entries(response.answers)) {
    answers[id] = normaliseScoreAnswer(answer);
  }
  return { ...response, answers };
}

/** The input-token count the API reports for a call, or null when it is absent. */
export function inputTokensOf(response: JevResponse): number | null {
  const value = response.usage?.input_tokens;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** The `noul` probability of one answer; throws when it is not there. */
export function noulAnswer(
  answers: Record<string, JevAnswer>,
  name: string,
): number {
  const answer = answers[name];
  if (
    !answer ||
    !('noul' in answer) ||
    typeof answer.noul !== 'number' ||
    !Number.isFinite(answer.noul)
  ) {
    throw new Error(`Invalid Jev answer for ${name}`);
  }
  return answer.noul;
}
