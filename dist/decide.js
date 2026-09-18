import { estimateTokens } from './state.js';
/** Tokens the request envelope (model name, key names) adds around state and questions. */
const REQUEST_OVERHEAD_TOKENS = 20;
/** The two noul questions asked about one call: keep the call, keep its result. */
export function questionsFor(call) {
    return {
        [`call_${call.id}`]: {
            type: 'noul',
            instructions: `Tool call ${call.id} (${call.tool}) should stay in the history: knowing this call was made, with its input, still matters for what the assistant does next`,
        },
        [`result_${call.id}`]: {
            type: 'noul',
            instructions: `The full output of tool call ${call.id} (${call.tool}, ${call.resultChars} chars) should stay in the history verbatim: the assistant still needs its contents and re-running the tool would not do`,
        },
    };
}
/**
 * Splits the candidate calls into batches whose questions, together with the
 * (always complete) state, fit one request.
 */
export function batchCalls(calls, stateTokens, maxRequestTokens) {
    const budget = maxRequestTokens - stateTokens - REQUEST_OVERHEAD_TOKENS;
    const batches = [];
    let current = [];
    let currentTokens = 0;
    for (const call of calls) {
        const tokens = estimateTokens(JSON.stringify(questionsFor(call)));
        if (current.length > 0 && currentTokens + tokens > budget) {
            batches.push(current);
            current = [];
            currentTokens = 0;
        }
        if (current.length === 0 && tokens > budget) {
            throw new Error(`state leaves no room for questions (${stateTokens} of ${maxRequestTokens} tokens)`);
        }
        current.push(call);
        currentTokens += tokens;
    }
    if (current.length > 0)
        batches.push(current);
    return batches;
}
export function decideCall(call, answer, keepThreshold) {
    const base = { id: call.id, tool: call.tool, ...answer };
    if (call.pinned)
        return { ...base, action: 'keep', reason: 'pinned' };
    if (answer.keepResult >= keepThreshold) {
        return { ...base, action: 'keep', reason: 'kept' };
    }
    if (answer.keepCall >= keepThreshold) {
        return { ...base, action: 'drop_result', reason: 'result_dropped' };
    }
    return { ...base, action: 'drop_call', reason: 'call_dropped' };
}
/** The bounded head plus one-line note that replaces a dieted tool result. */
export function truncatedResultText(text, isError, headChars) {
    if (text.length <= headChars + 120)
        return text;
    const head = headChars > 0 ? `${text.slice(0, headChars)}\n` : '';
    return `${head}[codex-context-diet truncated ${text.length - headChars} chars of this tool result${isError ? ' (error)' : ''}; re-run the tool if needed]`;
}
/**
 * Rebuilds the conversation from the decisions. A dropped call disappears
 * together with its result; a dropped result keeps a bounded head and note.
 * Messages that lose all their content are removed; untouched messages are
 * returned as the same objects they came in as.
 */
export function applyDecisions(messages, decisions, calls, headChars) {
    const byId = new Map(calls.map((call) => [call.id, call]));
    const actions = new Map();
    for (const decision of decisions) {
        const call = byId.get(decision.id);
        if (call && decision.action !== 'keep')
            actions.set(call.tool_use_id, decision.action);
    }
    const kept = [];
    for (const message of messages) {
        const touched = message.toolUses.some((tool) => actions.has(tool.tool_use_id)) ||
            (message.toolResults ?? []).some((result) => actions.has(result.tool_use_id));
        if (!touched) {
            kept.push(message);
            continue;
        }
        const toolUses = message.toolUses
            .filter((tool) => actions.get(tool.tool_use_id) !== 'drop_call')
            .map((tool) => {
            if (actions.get(tool.tool_use_id) !== 'drop_result')
                return tool;
            const text = truncatedResultText(tool.text ?? '', tool.isError ?? false, headChars);
            if ((tool.text ?? '') === text)
                return tool;
            const copy = {
                tool_use_id: tool.tool_use_id,
                tool: tool.tool,
                input: tool.input,
                text,
            };
            if (tool.isError)
                copy.isError = true;
            return copy;
        });
        const toolResults = (message.toolResults ?? [])
            .filter((result) => actions.get(result.tool_use_id) !== 'drop_call')
            .map((result) => {
            if (actions.get(result.tool_use_id) !== 'drop_result')
                return result;
            const text = truncatedResultText(result.text, result.isError ?? false, headChars);
            return text === result.text ? result : { tool_use_id: result.tool_use_id, text, isError: result.isError };
        });
        if (!message.toolUses.some((tool) => actions.get(tool.tool_use_id) === 'drop_call') &&
            !(message.toolResults ?? []).some((result) => actions.get(result.tool_use_id) === 'drop_call') &&
            toolUses.every((tool, index) => tool === message.toolUses[index]) &&
            toolResults.every((result, index) => result === message.toolResults?.[index])) {
            kept.push(message);
            continue;
        }
        if (message.text.trim().length === 0 && toolUses.length === 0 && toolResults.length === 0) {
            continue;
        }
        const rebuilt = { role: message.role, text: message.text, toolUses };
        if (toolResults.length > 0)
            rebuilt.toolResults = toolResults;
        kept.push(rebuilt);
    }
    return kept;
}
/** Characters of text, tool input and tool output a message holds. */
export function messageChars(message) {
    let total = message.text.length;
    for (const tool of message.toolUses) {
        try {
            total += JSON.stringify(tool.input).length;
        }
        catch {
            total += 20;
        }
    }
    for (const result of message.toolResults ?? [])
        total += result.text.length;
    return total;
}
export function reductionRatio(result) {
    const { charsBefore, charsAfter } = result.stats;
    return charsBefore === 0 ? 0 : (charsBefore - charsAfter) / charsBefore;
}
//# sourceMappingURL=decide.js.map