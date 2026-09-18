import type { CallAnswer, CallDecision, JevQuestions, Message, ToolCall } from './types.js';
/** The two noul questions asked about one call: keep the call, keep its result. */
export declare function questionsFor(call: ToolCall): JevQuestions;
/**
 * Splits the candidate calls into batches whose questions, together with the
 * (always complete) state, fit one request.
 */
export declare function batchCalls(calls: readonly ToolCall[], stateTokens: number, maxRequestTokens: number): ToolCall[][];
export declare function decideCall(call: Pick<ToolCall, 'id' | 'tool' | 'pinned'>, answer: CallAnswer, keepThreshold: number): CallDecision;
/** The bounded head plus one-line note that replaces a dieted tool result. */
export declare function truncatedResultText(text: string, isError: boolean, headChars: number): string;
/**
 * Rebuilds the conversation from the decisions. A dropped call disappears
 * together with its result; a dropped result keeps a bounded head and note.
 * Messages that lose all their content are removed; untouched messages are
 * returned as the same objects they came in as.
 */
export declare function applyDecisions(messages: readonly Message[], decisions: readonly CallDecision[], calls: readonly ToolCall[], headChars: number): Message[];
/** Characters of text, tool input and tool output a message holds. */
export declare function messageChars(message: Message): number;
export declare function reductionRatio(result: {
    stats: {
        charsBefore: number;
        charsAfter: number;
    };
}): number;
