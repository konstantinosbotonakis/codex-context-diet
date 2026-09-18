import type { JevQuestions } from './types.js';
/**
 * Question ids. Each one asks a single literal condition, because jev-1.13
 * answers the question that was written rather than the one that was meant;
 * conditions that cannot be separated are combined in code instead.
 */
export declare const Q_NEEDS_CONTENTS = "needs_contents";
export declare const Q_REPLACEABLE = "replaceable";
export declare const Q_KEEP_CALL = "keep_call";
export declare const Q_AGENT_DIRECTED = "agent_directed";
export declare const Q_BEHAVIOUR_CHANGE = "behaviour_change";
export interface QuestionInput {
    tool: string;
    inputLine: string;
    resultChars: number;
}
export declare function dietQuestions(current: QuestionInput, injectionGuard: boolean): JevQuestions;
