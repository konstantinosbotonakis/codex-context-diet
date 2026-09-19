import { type DietConfig } from '../config.js';
import type { JevQuestions } from '../types.js';
/**
 * Subagent context management.
 *
 * `SubagentStart` hands the subagent a result contract. `SubagentStop` asks
 * Jev whether the result is ready for the parent, and asks the subagent for one
 * more pass only when the answer is clearly no. Every path fails open, the
 * continue signal is bounded by `stop_hook_active` and a per-agent counter, and
 * interventions are recorded separately from diet decisions.
 */
export declare const SUBAGENT_CONTRACT: string;
export declare const SUBAGENT_CONTEXT: string;
export declare const Q_ANSWER_ACTIONABLE = "answer_actionable";
export declare const Q_EVIDENCE_PRESENT = "required_evidence_present";
export declare const Q_REDUNDANT_OUTPUT = "contains_large_redundant_output";
export declare const Q_REQUEST_SATISFIED = "request_satisfied";
export declare function subagentQuestions(): JevQuestions;
export interface SubagentVerdict {
    action: 'allow' | 'revise';
    reason: string | null;
    scores: Record<string, number>;
}
/** Deterministic policy over the four scores. Uncertainty allows completion. */
export declare function decideSubagentVerdict(answers: Record<string, number>, config: DietConfig): SubagentVerdict;
export declare function handleSubagent(payload: Record<string, unknown>, env: NodeJS.ProcessEnv): Promise<string>;
