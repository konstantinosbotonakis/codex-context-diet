import type { JevQuestions } from './types.js';
export declare const Q_KEEP_RESULT = "keep_result";
export declare const Q_KEEP_CALL = "keep_call";
export declare const Q_INJECTION = "injection";
export interface QuestionInput {
    tool: string;
    inputLine: string;
    resultChars: number;
}
export declare function dietQuestions(current: QuestionInput, injectionGuard: boolean): JevQuestions;
