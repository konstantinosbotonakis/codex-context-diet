import { createHash } from 'node:crypto';
import { basename } from 'node:path';
/** Shared reason string: stats counts it and the note names it. */
export const DUPLICATE_REASON = 'deterministic_duplicate_drop';
const ANSI = /\u001b\[[0-9;]*m/g;
/** Trailing spaces, ANSI colour and blank-line runs do not change what a result means. */
export function normalizeText(text) {
    return text
        .replace(ANSI, '')
        .split('\n')
        .map((line) => line.replace(/[ \t]+$/, ''))
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}
export function fingerprint(toolName, inputLine, resultText) {
    return createHash('sha256')
        .update(toolName + '\n' + normalizeText(inputLine) + '\n' + normalizeText(resultText))
        .digest('hex');
}
const READ_TOOLS = /^(?:read|read_file|readfile|view|view_file)$/i;
const PATHY = /^[^\s]*[/.][^\s]*$/;
const WRITE_TOOLS = /^(?:apply_patch|edit|write|write_file|edit_file|multiedit|notebook_edit)$/i;
const SHELL_WRITE = /(?:^|\s)(?:>|>>|sed\s+-i\b|tee\b|mv\s|rm\s|cp\s|truncate\b|touch\s)/;
/** The file a read-class result came from, when one can be named. */
export function resourceOf(toolName, inputLine) {
    const cleaned = inputLine.trim();
    if (READ_TOOLS.test(toolName) && cleaned.length > 0)
        return cleaned;
    if (PATHY.test(cleaned))
        return cleaned;
    return null;
}
/**
 * Which paths a call may have written. Unknown write shapes return `*`, which
 * invalidates every later read duplicate rather than claiming reproducibility.
 */
export function touchedPaths(toolName, toolInput) {
    const record = (toolInput && typeof toolInput === 'object' ? toolInput : {});
    const command = typeof record.command === 'string' ? record.command : '';
    if (WRITE_TOOLS.test(toolName)) {
        const paths = new Set();
        for (const key of ['file_path', 'filePath', 'path']) {
            const value = record[key];
            if (typeof value === 'string' && value.length > 0)
                paths.add(value);
        }
        for (const match of command.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) {
            const path = (match[1] ?? '').trim();
            if (path.length > 0)
                paths.add(path);
        }
        return paths.size > 0 ? [...paths] : ['*'];
    }
    if (SHELL_WRITE.test(command))
        return ['*'];
    return [];
}
function samePath(left, right) {
    if (left === right)
        return true;
    if (left.endsWith('/' + right) || right.endsWith('/' + left))
        return true;
    return basename(left) === basename(right);
}
function invalidated(entry, touches) {
    const at = Date.parse(entry.at);
    if (!Number.isFinite(at) || entry.resource === undefined)
        return true;
    return touches.some((touch) => {
        const when = Date.parse(touch.at);
        // A write in the same millisecond as the read is treated as later: the
        // conservative direction is to distrust the cached copy.
        if (!Number.isFinite(when) || when < at)
            return false;
        return touch.paths.some((path) => path === '*' || samePath(path, entry.resource));
    });
}
/**
 * A duplicate is only real when the tool, the normalised input and the
 * normalised result all match, and nothing wrote to the resource afterwards.
 */
export function findDuplicate(toolName, inputLine, resultText, cache, touches) {
    const hash = fingerprint(toolName, inputLine, resultText);
    const input = normalizeText(inputLine);
    for (let index = cache.length - 1; index >= 0; index -= 1) {
        const entry = cache[index];
        if (entry.hash !== hash || entry.tool_name !== toolName)
            continue;
        if (normalizeText(entry.input) !== input)
            continue;
        if (entry.resource !== undefined && invalidated(entry, touches))
            return null;
        return entry;
    }
    return null;
}
//# sourceMappingURL=dedupe.js.map