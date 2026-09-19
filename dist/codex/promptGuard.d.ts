import type { DietConfig } from '../config.js';
import type { JevAnswer, JevAsker, JevQuestions } from '../types.js';
export declare const Q_TOUCHES_PRODUCTION = "touches_production";
export declare const Q_IRREVERSIBLE = "irreversible";
export declare const Q_SENDS_EXTERNAL = "sends_external_communications";
export declare const Q_MODIFIES_BILLING = "modifies_billing";
export declare const Q_CHANGES_ACCESS = "changes_authentication_or_access";
export declare const Q_DELETES_DATA = "deletes_or_overwrites_data";
export declare const Q_TOUCHES_CREDENTIALS = "touches_credentials_or_secrets";
export declare const HAZARD_IDS: string[];
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
 * Seven hazard questions, one literal condition each. Same rule as the diet path:
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
    /** Input tokens the API billed for this call, when it reported usage. */
    inputTokens: number | null;
}
/** Never throws: a failure returns a null risk and the error text, and the prompt goes through. */
export declare function assessPrompt(context: PromptContext, asker: JevAsker | null, config: DietConfig): Promise<PromptAssessment>;
