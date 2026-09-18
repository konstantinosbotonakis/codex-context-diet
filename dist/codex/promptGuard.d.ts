import type { DietConfig } from '../config.js';
import type { JevAnswer, JevAsker, JevQuestions } from '../types.js';
export declare const Q_TOUCHES_PRODUCTION = "touches_production";
export declare const Q_IRREVERSIBLE = "irreversible";
export interface PromptHazard {
    id: string;
    score: number;
}
export interface PromptRisk {
    hazards: PromptHazard[];
    line: string | null;
}
export interface PromptContext {
    cwd: string;
    recent: string[];
    prompt: string;
}
/**
 * Two hazard questions, one literal condition each. Same rule as the diet path:
 * jev-1.13 answers the question that was written, so the boundary cases go in
 * the criteria instead of being left to interpretation.
 */
export declare function riskQuestions(): JevQuestions;
export declare function warnLine(hazards: readonly PromptHazard[]): string;
/** Pure. A hazard at or above the threshold flags the prompt. */
export declare function decidePromptRisk(answers: Record<string, JevAnswer>, config: DietConfig): PromptRisk;
export interface PromptAssessment {
    risk: PromptRisk | null;
    /** The transport error, when there was one. The caller decides whether to mention it. */
    error: string | null;
}
/** Never throws: a failure returns a null risk and the error text, and the prompt goes through. */
export declare function assessPrompt(context: PromptContext, asker: JevAsker | null, config: DietConfig): Promise<PromptAssessment>;
