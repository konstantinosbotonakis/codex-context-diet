import type { DietConfig } from './config.js';
/** Shell/exec tools whose output is often agent-directed and should not be dieted by default. */
export declare function isShellLikeToolName(toolName: string): boolean;
export declare function shouldSkipShellDiet(config: DietConfig, toolName: string): boolean;
/** When false, keep shell output but do not surface agent-directed injection warnings. */
export declare function shouldSuppressShellAgentDirectedWarning(config: DietConfig, toolName: string): boolean;
