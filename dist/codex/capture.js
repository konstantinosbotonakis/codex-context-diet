import { appendFileSync } from 'node:fs';
import { loadConfig } from '../config.js';
import { redactText } from '../privacy.js';
/**
 * Development aid: record the payloads a session produces.
 *
 * The capture honours the configured privacy mode and is redacted by default,
 * exactly like the cache and the event log, so a stray CONTEXT_DIET_CAPTURE
 * cannot quietly persist secrets. A raw capture needs the explicit
 * CONTEXT_DIET_CAPTURE_UNREDACTED=1 opt-in, which the README warns about.
 */
export function capturePayload(env, raw) {
    const target = env.CONTEXT_DIET_CAPTURE;
    if (!target || raw.length === 0)
        return;
    try {
        const text = env.CONTEXT_DIET_CAPTURE_UNREDACTED === '1'
            ? raw
            : redactText(raw, loadConfig(env).privacyMode).text;
        appendFileSync(target, text.replace(/\n/g, '') + '\n');
    }
    catch {
        // capture is a convenience; it never affects the run
    }
}
//# sourceMappingURL=capture.js.map