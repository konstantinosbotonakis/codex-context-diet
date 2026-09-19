import { clip, type Extractor } from './types.js';

const EXCEPTION = /^\s*(?:Uncaught\s+)?(?:[\w.]*(?:Error|Exception)\b[^\n]*|panic:[^\n]*|panicked\s+at[^\n]*)/;
const FRAME = /^\s*(?:at\s|File\s")/;
const TRACEBACK = /^\s*Traceback \(most recent call last\):/;

function collect(rows: string[], start: number, step: 1 | -1, cap: number): string[] {
  const frames: string[] = [];
  for (let index = start; index >= 0 && index < rows.length && frames.length < cap; index += step) {
    const row = rows[index] ?? '';
    if (!FRAME.test(row)) break;
    frames.push(clip(row.trim(), 300));
  }
  return frames;
}

/**
 * Python prints the traceback upwards: a frame line, its source line, the
 * next frame, and the exception last. Walk up collecting frames, skipping the
 * source lines, and stop at the header or a blank line.
 */
function collectPythonFrames(
  rows: string[],
  start: number,
  cap: number,
): { frames: string[]; header: string | null } {
  const frames: string[] = [];
  let header: string | null = null;
  for (let index = start; index >= 0 && frames.length < cap; index -= 1) {
    const row = rows[index] ?? '';
    if (TRACEBACK.test(row)) {
      header = clip(row.trim(), 300);
      break;
    }
    if (FRAME.test(row)) {
      frames.push(clip(row.trim(), 300));
      continue;
    }
    if (row.trim().length === 0) break;
    // The indented source line under a frame; keep walking.
  }
  return { frames, header };
}

export const stackTrace: Extractor = (input, budgets) => {
  const rows = input.resultText.split('\n');
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index] ?? '';
    if (!EXCEPTION.test(row)) continue;
    const exception = clip(row.trim(), 300);
    const after = collect(rows, index + 1, 1, budgets.maxStackFrames);
    if (after.length > 0) {
      const lines = [exception, ...after];
      return { kind: 'stack-trace', lines, retainedChars: lines.join('\n').length + 1 };
    }
    // Python prints the exception last, so its frames sit above the line.
    const { frames, header } = collectPythonFrames(rows, index - 1, budgets.maxStackFrames);
    if (frames.length === 0) continue;
    const lines = [...(header === null ? [] : [header]), ...frames, exception];
    return { kind: 'stack-trace', lines, retainedChars: lines.join('\n').length + 1 };
  }
  return null;
};
