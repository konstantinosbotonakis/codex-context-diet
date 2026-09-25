import type { CacheEntry } from './cache.js';
import { sampleResult } from './sample.js';
import { estimateTokens } from './state.js';

export const DIET_CONTEXT =
  'A coding assistant session is deciding whether to keep the full text of a tool result it has just received. ' +
  'history lists tool calls already seen in this session, oldest first, each as one line with a short digest of its ' +
  'result. current is the call and result being judged now. Each question asks whether the current result, or the ' +
  'fact that the call happened, still matters for the work ahead. Whatever is not kept is replaced by a bounded ' +
  'head and a note; the assistant can always re-run the tool.';

export interface DietStateInput {
  goal: string;
  history: CacheEntry[];
  toolName: string;
  inputLine: string;
  resultText: string;
}

export interface DietState {
  context: string;
  goal: string;
  history: { i: number; text: string }[];
  current: { call: string; result: string; resultChars: number };
}

export interface FittedDietState {
  state: DietState;
  tokens: number;
  stage: string;
}

function line(entry: CacheEntry, index: number, withDigest: boolean): { i: number; text: string } {
  const base =
    't' + (index + 1) + ' ' + entry.tool_name + ' ' + entry.input + ' -> ' + entry.chars + 'ch ' + entry.decision;
  return { i: index, text: withDigest ? base + ' | ' + entry.head : base };
}

/**
 * The state sent to Jev: what already happened, plus the result being judged.
 * Shrinks in stages and throws when even the smallest form does not fit, which
 * the adapter treats as "keep the result unchanged".
 */
export function buildDietState(
  input: DietStateInput,
  opts: { maxStateTokens: number; resultCapChars: number },
): FittedDietState {
  const call = input.toolName + ' ' + input.inputLine;
  const stateOf = (
    history: { i: number; text: string }[],
    result: string,
    stage: string,
  ): FittedDietState => {
    const state: DietState = {
      context: DIET_CONTEXT,
      goal: input.goal,
      history,
      current: { call, result, resultChars: input.resultText.length },
    };
    return { state, tokens: estimateTokens(JSON.stringify(state)), stage };
  };
  const history = input.history;
  const half = Math.max(1, Math.floor(history.length / 2));
  const olderHistory = history.slice(-half).map((entry, i) => line(entry, history.length - half + i, false));
  // Keep current evidence ahead of old digests. Every shrink stage uses the
  // signal sampler so failures in the middle survive a smaller state budget.
  const sampled = sampleResult(input.resultText, { budgetChars: opts.resultCapChars }).text;

  const candidates: (() => FittedDietState)[] = [
    () =>
      stateOf(
        history.map((entry, i) => line(entry, i, true)),
        sampled,
        'full',
      ),
    () => stateOf(history.map((entry, i) => line(entry, i, false)), sampled, 'digests dropped'),
    () => stateOf(olderHistory, sampled, 'oldest history dropped'),
    () => stateOf([], sampled, 'history dropped'),
    () => stateOf([], sampleResult(input.resultText, { budgetChars: Math.min(opts.resultCapChars, 2500) }).text, 'current sampled'),
    () => stateOf([], sampleResult(input.resultText, { budgetChars: Math.min(opts.resultCapChars, 400) }).text, 'current minimal sample'),
  ];

  let last = { tokens: 0, stage: 'full' };
  for (const build of candidates) {
    const candidate = build();
    last = { tokens: candidate.tokens, stage: candidate.stage };
    if (candidate.tokens <= opts.maxStateTokens) return candidate;
  }
  throw new Error('diet state too large for Jev (~' + last.tokens + ' tokens)');
}
