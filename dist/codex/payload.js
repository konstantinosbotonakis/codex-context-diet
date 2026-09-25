const PATCH_ALIASES = new Set(['apply_patch', 'Edit', 'Write']);
/** Replacing the whole response would discard media that a text model cannot judge. */
function containsMedia(value) {
    if (typeof value === 'string')
        return /^data:(?:image|audio|video)\//i.test(value);
    if (!value || typeof value !== 'object')
        return false;
    if (Array.isArray(value))
        return value.some(containsMedia);
    const record = value;
    if (['image', 'image_url', 'input_image', 'audio', 'input_audio', 'video'].includes(String(record.type)))
        return true;
    if (typeof record.blob === 'string')
        return true;
    if (typeof record.image_url === 'string' || typeof record.imageUrl === 'string')
        return true;
    const mime = record.mimeType ?? record.mime_type;
    if (typeof mime === 'string' && /^(image|audio|video)\//i.test(mime))
        return true;
    return Object.values(record).some(containsMedia);
}
function oneLine(text, limit) {
    const collapsed = text.replace(/\s+/g, ' ').trim();
    return collapsed.length <= limit ? collapsed : collapsed.slice(0, limit - 1) + '…';
}
function textBlocks(value) {
    if (!Array.isArray(value))
        return null;
    const parts = [];
    for (const block of value) {
        if (typeof block === 'string')
            parts.push(block);
        else if (block && typeof block === 'object') {
            const text = block.text;
            if (typeof text === 'string')
                parts.push(text);
        }
    }
    return parts.length > 0 ? parts.join('\n') : null;
}
/** tool_response -> text. Returns null when there is nothing worth judging. */
export function toolResultText(toolName, toolResponse) {
    if (toolName === 'view_image' || containsMedia(toolResponse))
        return null;
    if (toolResponse === null || toolResponse === undefined)
        return null;
    if (typeof toolResponse === 'string')
        return toolResponse.length > 0 ? toolResponse : null;
    if (typeof toolResponse === 'object') {
        const record = toolResponse;
        for (const key of ['output', 'stdout', 'text', 'content', 'result', 'message']) {
            const value = record[key];
            if (typeof value === 'string' && value.length > 0)
                return value;
            const blocks = textBlocks(value);
            if (blocks !== null)
                return blocks;
        }
    }
    try {
        const json = JSON.stringify(toolResponse);
        return json && json !== '{}' ? json : null;
    }
    catch {
        return null;
    }
}
/** One line describing what ran, capped at 200 characters. */
export function inputLine(toolName, toolInput) {
    if (toolInput === null || toolInput === undefined)
        return '';
    if (typeof toolInput === 'string')
        return oneLine(toolInput, 200);
    if (typeof toolInput === 'object') {
        const record = toolInput;
        if (typeof record.command === 'string')
            return oneLine(record.command, 200);
        if (typeof record.file_path === 'string')
            return oneLine(record.file_path, 200);
    }
    try {
        return oneLine(JSON.stringify(toolInput), 200);
    }
    catch {
        return '[unserializable input]';
    }
}
/** Patch output is the record of what changed: small, load-bearing, never dieted. */
export function isSkippedTool(toolName, config) {
    if (toolName.length === 0)
        return true;
    if (PATCH_ALIASES.has(toolName))
        return true;
    return config.neverDietTools.includes(toolName);
}
//# sourceMappingURL=payload.js.map