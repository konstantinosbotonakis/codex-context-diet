export function clip(text, limit) {
    return text.length <= limit ? text : text.slice(0, Math.max(0, limit - 3)) + '...';
}
export function textLines(text) {
    return text.split('\n');
}
export function retained(lines) {
    return lines.reduce((sum, line) => sum + line.length + 1, 0);
}
//# sourceMappingURL=types.js.map