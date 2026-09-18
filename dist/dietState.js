import { estimateTokens } from './state.js';
export const DIET_CONTEXT = 'A coding assistant session is deciding whether to keep the full text of a tool result it has just received. ' +
    'history lists tool calls already seen in this session, oldest first, each as one line with a short digest of its ' +
    'result. current is the call and result being judged now. Each question asks whether the current result, or the ' +
    'fact that the call happened, still matters for the work ahead. Whatever is not kept is replaced by a bounded ' +
    'head and a note; the assistant can always re-run the tool.';
function clip(text, limit) {
    return text.length <= limit ? text : text.slice(0, limit);
}
function abridge(text, head, tail) {
    if (text.length <= head + tail + 40)
        return text;
    return text.slice(0, head) + '\n[... ' + (text.length - head - tail) + ' chars omitted ...]\n' + text.slice(-tail);
}
function headNote(text, head) {
    return text.slice(0, head) + '\n[... ' + Math.max(0, text.length - head) + ' chars omitted ...]';
}
function line(entry, index, withDigest) {
    const base = 't' + (index + 1) + ' ' + entry.tool_name + ' ' + entry.input + ' -> ' + entry.chars + 'ch ' + entry.decision;
    return { i: index, text: withDigest ? base + ' | ' + entry.head : base };
}
/**
 * The state sent to Jev: what already happened, plus the result being judged.
 * Shrinks in stages and throws when even the smallest form does not fit, which
 * the adapter treats as "keep the result unchanged".
 */
export function buildDietState(input, opts) {
    const call = input.toolName + ' ' + input.inputLine;
    const stateOf = (history, result, stage) => {
        const state = {
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
    const candidates = [
        () => stateOf(history.map((entry, i) => line(entry, i, true)), clip(input.resultText, opts.resultCapChars), 'full'),
        () => stateOf(history.map((entry, i) => line(entry, i, true)), abridge(input.resultText, 2000, 500), 'current abridged'),
        () => stateOf(history.map((entry, i) => line(entry, i, false)), abridge(input.resultText, 2000, 500), 'digests dropped'),
        () => stateOf(olderHistory, abridge(input.resultText, 2000, 500), 'oldest history dropped'),
        () => stateOf(olderHistory, headNote(input.resultText, 400), 'current head only'),
        () => stateOf([], headNote(input.resultText, 400), 'history dropped'),
    ];
    let last = { tokens: 0, stage: 'full' };
    for (const build of candidates) {
        const candidate = build();
        last = { tokens: candidate.tokens, stage: candidate.stage };
        if (candidate.tokens <= opts.maxStateTokens)
            return candidate;
    }
    throw new Error('diet state too large for Jev (~' + last.tokens + ' tokens)');
}
//# sourceMappingURL=dietState.js.map