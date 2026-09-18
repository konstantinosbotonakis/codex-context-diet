import { appendFileSync } from 'node:fs';
/** Development aid: record the real payloads a session produces. Never on by default. */
export function capturePayload(env, raw) {
    const target = env.CONTEXT_DIET_CAPTURE;
    if (!target || raw.length === 0)
        return;
    try {
        appendFileSync(target, raw.replace(/\n/g, '') + '\n');
    }
    catch {
        // capture is a convenience; it never affects the run
    }
}
//# sourceMappingURL=capture.js.map