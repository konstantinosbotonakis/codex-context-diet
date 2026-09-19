import { clip } from './types.js';
const DIAGNOSTIC = /^\s*(?:error|warning)\b\s*[:\[]|\berror\s+TS\d+:|\.(?:ts|tsx|js|jsx|go|rs|py)\(\d+,\d+\):\s*error/i;
export const buildLog = (input, budgets) => {
    const hits = [];
    for (const row of input.resultText.split('\n')) {
        if (!DIAGNOSTIC.test(row))
            continue;
        hits.push(clip(row.trim(), 300));
        if (hits.length >= budgets.maxErrorLines)
            break;
    }
    if (hits.length === 0)
        return null;
    return {
        kind: 'build-log',
        lines: hits,
        retainedChars: hits.reduce((sum, line) => sum + line.length + 1, 0),
    };
};
//# sourceMappingURL=buildLog.js.map