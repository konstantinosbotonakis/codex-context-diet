import type { DietConfig } from '../config.js';
/** tool_response -> text. Returns null when there is nothing worth judging. */
export declare function toolResultText(toolName: string, toolResponse: unknown): string | null;
/** One line describing what ran, capped at 200 characters. */
export declare function inputLine(toolName: string, toolInput: unknown): string;
/** Patch output is the record of what changed: small, load-bearing, never dieted. */
export declare function isSkippedTool(toolName: string, config: DietConfig): boolean;
