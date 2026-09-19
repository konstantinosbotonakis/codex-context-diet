import type { DietConfig, PrivacyMode } from './config.js';
/**
 * Deterministic secret redaction, applied before anything is sent to Jev and
 * before anything is written to the cache or the debug log.
 *
 * Classification is local: no candidate secret is ever sent to a model to ask
 * whether it is a secret. The rules are intentionally conservative. A missed
 * secret costs privacy, a false positive costs a little readability, and the
 * placeholders keep the shape of the text so Jev can still judge it.
 */
export interface RedactionResult {
    text: string;
    /** How many spans were replaced. The spans themselves are never recorded. */
    findings: number;
}
export declare function redactText(text: string, mode: PrivacyMode): RedactionResult;
/** Deep walk for structured payloads. Non-strings pass through untouched. */
export declare function redactValue(value: unknown, mode: PrivacyMode): unknown;
/**
 * True when a result must stay local: the command or path names something the
 * user excluded from external transmission. Path exclusions apply in strict
 * mode; `neverSendTools` applies in every mode except `off`.
 */
export declare function isNeverSendInput(toolName: string, inputLine: string, config: DietConfig): boolean;
