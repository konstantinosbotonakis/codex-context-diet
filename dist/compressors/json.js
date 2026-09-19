import { clip } from './types.js';
function describe(value) {
    if (value === null)
        return 'null';
    if (Array.isArray(value))
        return 'array of ' + value.length + ' item(s)';
    if (typeof value === 'object')
        return 'object with ' + Object.keys(value).length + ' key(s)';
    if (typeof value === 'string')
        return clip(JSON.stringify(value), 120);
    return String(value);
}
/** A JSON body is better judged by its shape than by its first page. */
export const jsonShape = (input, budgets) => {
    const text = input.resultText.trim();
    if (!(text.startsWith('{') || text.startsWith('[')))
        return null;
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch {
        return null;
    }
    const facts = ['JSON ' + (Array.isArray(parsed) ? 'array of ' + parsed.length + ' item(s)' : 'object')];
    const lines = [];
    if (Array.isArray(parsed)) {
        if (parsed.length > 0)
            lines.push('first item: ' + clip(JSON.stringify(parsed[0]), 200));
    }
    else if (parsed !== null && typeof parsed === 'object') {
        for (const key of Object.keys(parsed).slice(0, budgets.maxSummaryLines * 2)) {
            lines.push(key + ': ' + describe(parsed[key]));
        }
    }
    return {
        kind: 'json',
        facts,
        lines,
        retainedChars: lines.reduce((sum, line) => sum + line.length + 1, 0),
    };
};
//# sourceMappingURL=json.js.map