import { fingerprint, normalizeText } from './dedupe.js';
/** Stable key for one tool plus one input, so a recovery scores once per input. */
export function inputKey(toolName, inputLine) {
    return fingerprint(toolName, inputLine, '');
}
export function detectRecovery(cache, alreadySeen, current, now, windowMs) {
    const input = normalizeText(current.inputLine);
    if (alreadySeen.includes(inputKey(current.toolName, current.inputLine)))
        return null;
    for (let index = cache.length - 1; index >= 0; index -= 1) {
        const entry = cache[index];
        if (entry.decision !== 'drop_result')
            continue;
        if (entry.tool_name !== current.toolName)
            continue;
        if (normalizeText(entry.input) !== input)
            continue;
        const at = Date.parse(entry.at);
        if (!Number.isFinite(at))
            continue;
        const afterMs = now - at;
        if (afterMs < 0 || afterMs > windowMs)
            continue;
        return { entry, afterMs, afterCalls: cache.length - index };
    }
    return null;
}
//# sourceMappingURL=recovery.js.map