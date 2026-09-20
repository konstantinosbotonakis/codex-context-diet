import { type DietConfig } from '../config.js';
import type { JevAnswer, JevQuestions, JevResponse, JevState } from '../types.js';
export interface LayaPaths {
    dir: string;
    socket: string;
    log: string;
    worker: string;
    venvPython: string;
    headDir: string;
    head: string;
}
export declare function layaPaths(env: NodeJS.ProcessEnv): LayaPaths;
/**
 * The head trained for the configured checkpoint, or an empty string.
 *
 * Heads are fitted per checkpoint, so a subfolder without a measured head
 * falls back to Laya's own answers rather than reading a mismatched probe.
 */
export declare function layaHeadPath(config: DietConfig, env: NodeJS.ProcessEnv): string;
/** Config first, then the managed venv, then whatever python3 is on PATH. */
export declare function resolveLayaPython(config: DietConfig, env: NodeJS.ProcessEnv): string;
interface LayaAnswer {
    type?: string;
    noul?: number;
    choice?: string;
    score?: number;
    probabilities?: Record<string, number>;
    confidence?: number;
}
interface LayaReply {
    ok?: boolean;
    error?: string;
    answers?: Record<string, LayaAnswer>;
    usage?: {
        input_tokens?: number;
    };
    model?: string;
    device?: string;
    laya?: string;
    loaded?: boolean;
    subfolder?: string | null;
    head?: LayaHeadScores | null;
    workerMtime?: number | null;
    headMtime?: number | null;
}
export interface LayaHeadScores {
    drop: number;
    hazard: number;
    dropThreshold: number;
    hazardThreshold: number;
}
/**
 * The head's verdict, written in the policy's own language.
 *
 * The trained head decides drop or keep from the state itself, because Laya's
 * own question heads carry almost no signal on this task. The deterministic
 * policy still makes the call: these answers are just what it reads.
 */
export declare function headAnswers(head: LayaHeadScores): Record<string, JevAnswer>;
/**
 * The daemon, started on demand. A cold start loads a checkpoint, so the wait
 * is the warm timeout, not the per-answer timeout.
 */
export declare function ensureLayaDaemon(config: DietConfig, env: NodeJS.ProcessEnv): Promise<void>;
/** Loads the checkpoint in the daemon so the first real answer is not the slow one. */
export declare function warmLaya(config: DietConfig, env: NodeJS.ProcessEnv): Promise<LayaReply>;
export declare function layaStatus(config: DietConfig, env: NodeJS.ProcessEnv): Promise<LayaReply | null>;
/**
 * Laya's answers in the plugin's own shape. A score arrives as the expected
 * level index, which is normalised to 0..1 so both providers read the same,
 * and the probabilities are keyed by the level labels the caller supplied.
 */
export declare function mapLayaAnswers(questions: JevQuestions, answers: Record<string, LayaAnswer>): Record<string, JevAnswer>;
/** The asker the diet path uses when the provider is Laya. */
export declare function createLayaAsker(config: DietConfig, env: NodeJS.ProcessEnv): {
    ask(state: JevState, questions: JevQuestions): Promise<JevResponse>;
};
export {};
