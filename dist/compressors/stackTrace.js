import { clip } from './types.js';
const EXCEPTION = /^\s*(?:Uncaught\s+)?(?:[\w.]*(?:Error|Exception)\b[^\n]*|panic:[^\n]*)/;
const FRAME = /^\s*(?:at\s|File\s")/;
export const stackTrace = (input, budgets) => {
    const rows = input.resultText.split('\n');
    for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index] ?? '';
        if (!EXCEPTION.test(row))
            continue;
        const frames = [];
        for (let next = index + 1; next < rows.length && frames.length < budgets.maxStackFrames; next += 1) {
            const frame = rows[next] ?? '';
            if (!FRAME.test(frame))
                break;
            frames.push(clip(frame.trim(), 300));
        }
        if (frames.length === 0)
            continue;
        return {
            kind: 'stack-trace',
            lines: [clip(row.trim(), 300), ...frames],
            retainedChars: frames.reduce((sum, line) => sum + line.length + 1, row.length),
        };
    }
    return null;
};
//# sourceMappingURL=stackTrace.js.map