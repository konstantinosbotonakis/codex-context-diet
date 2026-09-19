/**
 * Development aid: record the payloads a session produces.
 *
 * The capture honours the configured privacy mode and is redacted by default,
 * exactly like the cache and the event log, so a stray CONTEXT_DIET_CAPTURE
 * cannot quietly persist secrets. A raw capture needs the explicit
 * CONTEXT_DIET_CAPTURE_UNREDACTED=1 opt-in, which the README warns about.
 */
export declare function capturePayload(env: NodeJS.ProcessEnv, raw: string): void;
