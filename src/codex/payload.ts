import type { DietConfig } from '../config.js';

const PATCH_ALIASES = new Set(['apply_patch', 'Edit', 'Write']);

function oneLine(text: string, limit: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= limit ? collapsed : collapsed.slice(0, limit - 1) + '…';
}

function textBlocks(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const parts: string[] = [];
  for (const block of value) {
    if (typeof block === 'string') parts.push(block);
    else if (block && typeof block === 'object') {
      const text = (block as Record<string, unknown>).text;
      if (typeof text === 'string') parts.push(text);
    }
  }
  return parts.length > 0 ? parts.join('\n') : null;
}

/** tool_response -> text. Returns null when there is nothing worth judging. */
export function toolResultText(_toolName: string, toolResponse: unknown): string | null {
  if (toolResponse === null || toolResponse === undefined) return null;
  if (typeof toolResponse === 'string') return toolResponse.length > 0 ? toolResponse : null;
  if (typeof toolResponse === 'object') {
    const record = toolResponse as Record<string, unknown>;
    for (const key of ['output', 'stdout', 'text', 'content', 'result', 'message']) {
      const value = record[key];
      if (typeof value === 'string' && value.length > 0) return value;
      const blocks = textBlocks(value);
      if (blocks !== null) return blocks;
    }
  }
  try {
    const json = JSON.stringify(toolResponse);
    return json && json !== '{}' ? json : null;
  } catch {
    return null;
  }
}

/** One line describing what ran, capped at 200 characters. */
export function inputLine(toolName: string, toolInput: unknown): string {
  if (toolInput === null || toolInput === undefined) return '';
  if (typeof toolInput === 'string') return oneLine(toolInput, 200);
  if (typeof toolInput === 'object') {
    const record = toolInput as Record<string, unknown>;
    if (typeof record.command === 'string') return oneLine(record.command, 200);
    if (typeof record.file_path === 'string') return oneLine(record.file_path, 200);
  }
  try {
    return oneLine(JSON.stringify(toolInput), 200);
  } catch {
    return '[unserializable input]';
  }
}

/** Patch output is the record of what changed: small, load-bearing, never dieted. */
export function isSkippedTool(toolName: string, config: DietConfig): boolean {
  if (toolName.length === 0) return true;
  if (PATCH_ALIASES.has(toolName)) return true;
  return config.neverDietTools.includes(toolName);
}
