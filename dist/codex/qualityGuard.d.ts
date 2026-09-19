import { type DietConfig } from '../config.js';
import type { JevQuestions } from '../types.js';
/**
 * Optional completion-quality guard for the Stop event.
 *
 * Off by default until the evaluation corpus shows it behaves. When on, four
 * independent Jev questions run over the last assistant message, deterministic
 * policy decides, and at most `qualityGuardMaxInterventions` continuations are
 * requested per turn. `stop_hook_active` and the per-turn ledger make a loop
 * impossible, and any failure lets the turn finish.
 */
export declare const QUALITY_CONTEXT: string;
export declare const Q_REQUEST_SATISFIED = "request_satisfied";
export declare const Q_VERIFICATION_COMPLETE = "verification_complete";
export declare const Q_KNOWN_FAILURE = "known_failure_remaining";
export declare const Q_UNSUPPORTED_CLAIM = "unsupported_claim_present";
export declare function qualityQuestions(): JevQuestions;
export interface QualityVerdict {
    action: 'allow' | 'continue';
    reason: string | null;
    scores: Record<string, number>;
}
/** Deterministic policy over the four scores, most severe first. Uncertainty allows completion. */
export declare function decideQualityVerdict(answers: Record<string, number>, config: DietConfig): QualityVerdict;
export declare function handleStop(payload: Record<string, unknown>, env: NodeJS.ProcessEnv): Promise<string>;
