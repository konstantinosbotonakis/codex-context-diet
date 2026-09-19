/**
 * Representative sampling for long tool results.
 *
 * A naive head-of-output sample hides a failure that sits in the middle. This
 * sampler keeps a bounded head, the highest-signal lines from the omitted
 * middle, and the tail, so a 100k-character log is judged on its evidence
 * rather than on its first page. Formats are recognised by line shape, so an
 * unknown output still gets head, signal lines and tail.
 */
export interface SampleOptions {
  /** Hard character budget for the returned text. */
  budgetChars: number;
  /** Preferred head size; clamped to fit the budget. */
  headChars?: number;
  /** Preferred tail size; clamped to fit the budget. */
  tailChars?: number;
  /** Maximum signal lines kept from the middle. */
  maxSignalLines?: number;
  /** Maximum characters kept per signal line. */
  maxSignalLineChars?: number;
}

export interface SampleResult {
  text: string;
  signalLines: number;
  /** Characters of the original text that the sample does not contain. */
  omitted: number;
}

interface Line {
  start: number;
  end: number;
  text: string;
}

interface SignalPattern {
  id: string;
  /** Lower is more important when the budget forces a choice. */
  priority: number;
  /** Cap per category, so a pathological log cannot flood the sample. */
  cap: number;
  pattern: RegExp;
}

const PATTERNS: readonly SignalPattern[] = [
  { id: 'error', priority: 0, cap: 20, pattern: /\b(?:err|error|exception|assertionerror|panic|fatal)\b/i },
  { id: 'failure', priority: 0, cap: 20, pattern: /\b(?:fail|failed|failure|failures)\b/i },
  { id: 'summary', priority: 1, cap: 12, pattern: /\b\d+\s+(?:passed|failed|skipped|pending)\b|\b(?:test suites?|tests?|total)\s*[:=]\s*\d+/i },
  { id: 'exit', priority: 1, cap: 4, pattern: /\bexit(?:ed|ing)?\s*(?:code|status)?\s*[:=]?\s*\d+/i },
  { id: 'location', priority: 2, cap: 12, pattern: /(?:^|[\s("'])(?:\.{0,2}\/)?[\w.-]+(?:\/[\w.-]+)*\.\w{1,5}:\d+(?::\d+)?/ },
  { id: 'warning', priority: 3, cap: 8, pattern: /\bwarn(?:ing)?\b/i },
];

const MIN_BUDGET = 256;

function toLines(text: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  while (start <= text.length) {
    const newline = text.indexOf('\n', start);
    const end = newline === -1 ? text.length : newline + 1;
    lines.push({ start, end, text: text.slice(start, newline === -1 ? text.length : newline) });
    if (newline === -1) break;
    start = end;
  }
  return lines;
}

function classify(line: Line): SignalPattern | null {
  let best: SignalPattern | null = null;
  for (const pattern of PATTERNS) {
    if (!pattern.pattern.test(line.text)) continue;
    if (best === null || pattern.priority < best.priority) best = pattern;
  }
  return best;
}

export function sampleResult(text: string, options: SampleOptions): SampleResult {
  const budget = Math.max(MIN_BUDGET, Math.floor(options.budgetChars));
  if (text.length <= budget) return { text, signalLines: 0, omitted: 0 };

  const headChars = Math.max(0, Math.min(options.headChars ?? 1500, Math.floor(budget / 2)));
  const tailChars = Math.max(0, Math.min(options.tailChars ?? 400, Math.floor(budget / 4)));
  const maxSignalLines = Math.max(0, options.maxSignalLines ?? 24);
  const maxSignalLineChars = Math.max(40, options.maxSignalLineChars ?? 300);
  const headEnd = headChars;
  const tailStart = Math.max(headEnd, text.length - tailChars);

  const lines = toLines(text);
  const used = new Map<string, number>();
  const chosen: { line: Line; priority: number }[] = [];
  for (const line of lines) {
    if (line.start < headEnd || line.end > tailStart) continue;
    if (line.text.trim().length === 0) continue;
    const pattern = classify(line);
    if (pattern === null) continue;
    const count = used.get(pattern.id) ?? 0;
    if (count >= pattern.cap) continue;
    used.set(pattern.id, count + 1);
    chosen.push({ line, priority: pattern.priority });
  }
  chosen.sort((a, b) => a.priority - b.priority || a.line.start - b.line.start);
  const selected = chosen.slice(0, maxSignalLines);

  const assemble = (keep: { line: Line; priority: number }[]): string => {
    const pieces = keep
      .map(({ line }) => ({ start: line.start, end: line.end, text: line.text.slice(0, maxSignalLineChars) }))
      .sort((a, b) => a.start - b.start);
    let out = text.slice(0, headEnd);
    let cursor = headEnd;
    for (const piece of pieces) {
      if (piece.start > cursor) out += '\n[... ' + (piece.start - cursor) + ' chars omitted ...]\n';
      out += piece.text + '\n';
      cursor = piece.end;
    }
    if (cursor < tailStart) out += '[... ' + (tailStart - cursor) + ' chars omitted ...]\n';
    out += text.slice(tailStart);
    return out;
  };

  let out = assemble(selected);
  while (out.length > budget && selected.length > 0) {
    selected.pop();
    out = assemble(selected);
  }
  if (out.length > budget) out = out.slice(0, budget);
  const retained = Math.min(text.length, headEnd + tailChars + selected.reduce((sum, item) => sum + item.line.text.length, 0));
  return { text: out, signalLines: selected.length, omitted: Math.max(0, text.length - retained) };
}

