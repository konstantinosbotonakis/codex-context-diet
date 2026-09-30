import type { DietConfig } from './config.js';
import type { JevAsker } from './types.js';
export declare const FILE_SCOUT_CONTEXT: string;
export interface FileScoutRequest {
    path: string;
    question: string;
    goal?: string;
    cwd?: string;
    maxSampleChars?: number;
}
export type ScoutAction = 'read' | 'skip' | 'blocked' | 'deterministic_skip';
export type ScoutValue = 'high' | 'medium' | 'low' | 'none';
export interface FileScoutBooleanResult {
    path: string;
    probability: number;
    answer: boolean;
    action: ScoutAction;
    reason: string;
    sampleChars: number;
    fileChars: number;
    model: string | null;
    input_tokens: number | null;
    value: ScoutValue;
}
export interface FileScoutChoiceResult {
    path: string;
    choice: string | null;
    probabilities: Record<string, number> | null;
    confidence: number | null;
    action: ScoutAction;
    reason: string;
    sampleChars: number;
    fileChars: number;
    model: string | null;
    input_tokens: number | null;
    value: ScoutValue;
}
export interface FileScoutBatchItem {
    path: string;
    probability: number;
    answer: boolean;
    action: ScoutAction;
    reason: string;
    value: ScoutValue;
}
export interface FileScoutBatchResult {
    question: string;
    goal?: string;
    results: FileScoutBatchItem[];
    usefulResults: FileScoutBatchItem[];
    skipped: string[];
    jevCalls: number;
    input_tokens: number | null;
    model: string | null;
}
export declare function resolveScoutPath(raw: string, cwd: string): string;
export declare function isUsefulScoutResult(item: FileScoutBatchItem): boolean;
export declare function jevFileBoolean(asker: JevAsker, config: DietConfig, input: FileScoutRequest): Promise<FileScoutBooleanResult>;
export declare function jevFileChoice(asker: JevAsker, config: DietConfig, input: FileScoutRequest & {
    options: string[];
}): Promise<FileScoutChoiceResult>;
export declare function expandScoutPaths(rawPaths: string[], cwd: string, maxFiles: number): string[];
export declare function jevFiles(asker: JevAsker, config: DietConfig, input: {
    paths: string[];
    question: string;
    goal?: string;
    cwd?: string;
    maxFiles?: number;
}): Promise<FileScoutBatchResult>;
