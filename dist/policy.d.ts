import type { DietConfig, ToolPolicy } from './config.js';
import type { PressureStage } from './pressure.js';
/**
 * Tool and output policies.
 *
 * A policy is a match string plus the fields it overrides. Matches stay
 * readable: `*`, an exact tool, `Bash:test`, `family:bash` or `output:test-log`.
 * The last matching entry wins, so the config file reads top to bottom.
 */
export interface PolicyContext {
    toolName: string;
    inputLine: string;
    outputClass: string;
    pressure: PressureStage;
}
export interface EffectivePolicy {
    minTokens: number;
    keepThreshold: number;
    dropThreshold: number;
    pressure: PressureStage;
    /** The match string that won, or `base` when nothing matched. */
    source: string;
}
export type CommandCategory = 'test' | 'build' | 'git' | 'install' | 'other';
export declare function commandCategory(inputLine: string): CommandCategory;
export type ToolFamily = 'bash' | 'read' | 'mcp' | 'other';
export declare function toolFamily(toolName: string): ToolFamily;
export declare function policyMatches(policy: ToolPolicy, context: PolicyContext): boolean;
export declare function resolveEffectivePolicy(config: DietConfig, context: PolicyContext): EffectivePolicy;
/** Output class from a bounded sample, so the classifier cannot scan a whole file. */
export declare function outputClassOf(resultText: string, maxChars: number): string;
