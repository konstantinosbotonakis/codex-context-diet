/** Retained-token marks for the stages. Fractions of a large context, not measurements. */
export const PRESSURE_THRESHOLDS = { moderate: 40_000, high: 90_000, critical: 150_000 };
export function pressureStage(retained) {
    if (retained >= PRESSURE_THRESHOLDS.critical)
        return 'critical';
    if (retained >= PRESSURE_THRESHOLDS.high)
        return 'high';
    if (retained >= PRESSURE_THRESHOLDS.moderate)
        return 'moderate';
    return 'low';
}
/** Characters the session is estimated to still be carrying. */
export function retainedChars(cache) {
    let chars = 0;
    for (const entry of cache) {
        const kept = typeof entry.keptChars === 'number' && Number.isFinite(entry.keptChars)
            ? entry.keptChars
            : entry.chars;
        chars += Math.max(0, kept);
    }
    return chars;
}
export function retainedTokens(cache) {
    return Math.round(retainedChars(cache) / 4);
}
//# sourceMappingURL=pressure.js.map