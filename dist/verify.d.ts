import type { JevAsker, Message } from './types.js';
export interface VerificationCheck {
    name: string;
    ok: boolean;
    detail: string;
}
export interface VerificationReport {
    ok: boolean;
    checks: VerificationCheck[];
    stats: {
        charsBefore: number;
        charsAfter: number;
        reduction: number;
        stateTokens: number;
    };
}
export declare function sampleLog(): string;
/** A goal, three tool calls, and one bulky failing result. Nothing here costs money. */
export declare function sampleTranscript(): Message[];
/** Deterministic asker for tests and offline runs. '*' is the fallback score. */
export declare function fakeAsker(scores: Record<string, number>): JevAsker;
/** An asker that always throws, to prove the paths that must not reach the network. */
export declare function throwingAsker(message: string): JevAsker;
/** Offline proof that the decision path is wired correctly. Never touches the network. */
export declare function verifyCompaction(deps: {
    asker: JevAsker;
}): Promise<VerificationReport>;
