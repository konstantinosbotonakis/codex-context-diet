import { basename } from 'node:path';
const RULES = [
    {
        id: 'private-key',
        placeholder: '<REDACTED_PRIVATE_KEY>',
        pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    },
    {
        id: 'jwt',
        placeholder: '<REDACTED_JWT>',
        pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    },
    {
        id: 'openai-key',
        placeholder: '<REDACTED_API_KEY>',
        pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/g,
    },
    {
        id: 'github-token',
        placeholder: '<REDACTED_GITHUB_TOKEN>',
        pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}\b|\bgithub_pat_[A-Za-z0-9_]{16,}\b/g,
    },
    {
        id: 'aws-key-id',
        placeholder: '<REDACTED_AWS_KEY>',
        pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    },
    {
        id: 'aws-secret',
        placeholder: '<REDACTED_AWS_SECRET>',
        pattern: /aws_secret_access_key\s*[=:]\s*["']?[A-Za-z0-9/+=]{30,}["']?/gi,
    },
    {
        id: 'connection-string',
        placeholder: '<REDACTED_CONNECTION_STRING>',
        pattern: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp|mssql):\/\/[^\s"'`]+/gi,
    },
    {
        id: 'bearer-token',
        placeholder: '<REDACTED_TOKEN>',
        pattern: /([Bb]earer\s+)[A-Za-z0-9._~+/=-]{16,}/g,
        replacement: '$1<REDACTED_TOKEN>',
    },
    {
        id: 'assignment',
        placeholder: '<REDACTED_SECRET>',
        // The value may not start with `<`, so a placeholder written by an earlier
        // rule cannot be mistaken for one more `key=value` assignment.
        pattern: /(api[_-]?key|apikey|secret|token|password|passwd|pwd|access[_-]?key|client[_-]?secret|private[_-]?key)\s*["']?\s*[:=]\s*["']?[^\s"',;<]{8,}/gi,
        replacement: '$1=<REDACTED_SECRET>',
    },
];
const REDACTION_RULES = RULES;
export function redactText(text, mode) {
    if (mode === 'off' || text.length === 0)
        return { text, findings: 0 };
    let out = text;
    let findings = 0;
    for (const rule of REDACTION_RULES) {
        const before = out;
        out = out.replace(rule.pattern, rule.replacement ?? rule.placeholder);
        if (out !== before)
            findings += 1;
    }
    return { text: out, findings };
}
/** Deep walk for structured payloads. Non-strings pass through untouched. */
export function redactValue(value, mode) {
    if (typeof value === 'string')
        return redactText(value, mode).text;
    if (Array.isArray(value))
        return value.map((item) => redactValue(item, mode));
    if (value !== null && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactValue(item, mode)]));
    }
    return value;
}
/** Minimal glob support: `**` crosses directories, `*` and `?` do not. */
function globToRegExp(glob) {
    const source = glob
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*\//g, '\u0000')
        .replace(/\*\*/g, '\u0001')
        .replace(/\*/g, '[^/]*')
        .replace(/\?/g, '[^/]')
        .replace(/\u0000/g, '(?:.*/)?')
        .replace(/\u0001/g, '.*');
    return new RegExp('^' + source + '$');
}
/**
 * True when a result must stay local: the command or path names something the
 * user excluded from external transmission. Path exclusions apply in strict
 * mode; `neverSendTools` applies in every mode except `off`.
 */
export function isNeverSendInput(toolName, inputLine, config) {
    if (config.privacyMode === 'off')
        return false;
    if (config.neverSendTools.some((tool) => tool.toLowerCase() === toolName.toLowerCase()))
        return true;
    if (config.privacyMode !== 'strict' || config.neverSendPaths.length === 0)
        return false;
    const patterns = config.neverSendPaths.map(globToRegExp);
    const candidates = inputLine.split(/[^A-Za-z0-9_./~@-]+/).filter((token) => token.length > 0);
    candidates.push(inputLine);
    return candidates.some((candidate) => patterns.some((pattern) => pattern.test(candidate) || pattern.test(basename(candidate))));
}
//# sourceMappingURL=privacy.js.map