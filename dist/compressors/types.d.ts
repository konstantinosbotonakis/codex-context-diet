export interface CapsuleInput {
    toolName: string;
    inputLine: string;
    resultText: string;
    isError: boolean;
}
export interface CapsuleBudgets {
    maxChars: number;
    maxErrorLines: number;
    maxStackFrames: number;
    maxSummaryLines: number;
    headChars: number;
}
export interface ExtractedCapsule {
    /** Which extractor produced the body, recorded in debug events. */
    kind: string;
    /** Compact facts such as an exit status or a test summary. */
    facts?: string[];
    /** Evidence lines, each already bounded. */
    lines: string[];
    /** Source characters these lines actually represent. */
    retainedChars: number;
}
export type Extractor = (input: CapsuleInput, budgets: CapsuleBudgets) => ExtractedCapsule | null;
export declare function clip(text: string, limit: number): string;
export declare function textLines(text: string): string[];
export declare function retained(lines: string[]): number;
