import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { pluginDataDir } from './config.js';

export interface RawRecord {
  [key: string]: unknown;
}

export interface SessionData {
  sessionId: string;
  entries: RawRecord[];
}

export interface UsageInput {
  sessions: SessionData[];
  events: RawRecord[];
  now?: Date;
  /** Which data directories were read, for the header line. */
  stores?: string[];
}

export interface UsageWindow {
  label: string;
  start: number;
  sessions: number;
  judged: number;
  replaced: number;
  charsDropped: number;
  jevCalls: number;
  guardRuns: number;
  guardFlags: number;
  keyWarnings: number;
}

export interface UsageReport {
  windows: UsageWindow[];
  earliest: number | null;
  logLines: number;
}

export const WINDOWS = [
  { label: 'today', days: 1 },
  { label: '7 days', days: 7 },
  { label: '30 days', days: 30 },
] as const;

/** Local midnight, n days back. setDate rather than millisecond maths, so DST is handled. */
export function localMidnight(now: Date, daysBack: number): number {
  const date = new Date(now.getTime());
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - daysBack);
  return date.getTime();
}

function timestamp(record: RawRecord): number | null {
  const value = Date.parse(String(record.at ?? ''));
  return Number.isFinite(value) ? value : null;
}

export function summarizeUsage(
  input: UsageInput,
  jevReasons: readonly string[],
  specs: readonly { label: string; days: number }[] = WINDOWS,
): UsageReport {
  const now = input.now ?? new Date();
  const end = now.getTime();
  const windows = specs.map((spec) => ({
    label: spec.label,
    start: localMidnight(now, Math.max(0, spec.days - 1)),
    sessions: 0,
    judged: 0,
    replaced: 0,
    charsDropped: 0,
    jevCalls: 0,
    guardRuns: 0,
    guardFlags: 0,
    keyWarnings: 0,
  }));
  const seen = windows.map(() => new Set<string>());
  let earliest: number | null = null;

  const bump = (when: number, apply: (window: UsageWindow, index: number) => void): void => {
    if (earliest === null || when < earliest) earliest = when;
    windows.forEach((window, index) => {
      if (when >= window.start && when <= end) apply(window, index);
    });
  };

  for (const session of input.sessions) {
    for (const entry of session.entries) {
      const when = timestamp(entry);
      if (when === null) continue;
      bump(when, (window, index) => {
        window.judged += 1;
        seen[index]!.add(session.sessionId);
        if (entry.decision === 'drop_result') {
          window.replaced += 1;
          window.charsDropped += typeof entry.chars === 'number' ? entry.chars : 0;
        }
      });
    }
  }

  for (const event of input.events) {
    const when = timestamp(event);
    if (when === null) continue;
    const kind = String(event.kind ?? 'diet');
    const reason = String(event.reason ?? '');
    bump(when, (window) => {
      if (kind === 'prompt_guard') {
        window.guardRuns += 1;
        if (event.flagged === true) window.guardFlags += 1;
        return;
      }
      if (kind === 'key_missing' || kind === 'key_rejected') {
        window.keyWarnings += 1;
        return;
      }
      if (jevReasons.includes(reason)) window.jevCalls += 1;
    });
  }

  return {
    windows: windows.map((window, index) => ({ ...window, sessions: seen[index]!.size })),
    earliest,
    logLines: input.events.length,
  };
}

function formatNumber(value: number): string {
  return value.toLocaleString('en-US');
}

export interface RenderOptions {
  timeZone: string;
  now?: Date;
  stores?: string[];
}

/** A table of counts. Never prints tool output, prompts, commands, or any other content. */
export function renderUsage(report: UsageReport, options: RenderOptions): string {
  const now = options.now ?? new Date();
  const localToday = new Date(localMidnight(now, 0));
  const lines: string[] = [];
  lines.push('Codex Context Diet, usage on this machine');
  lines.push(
    'today is ' + localToday.toDateString() + ' (' + options.timeZone + ')' +
      (report.earliest === null
        ? ', no data recorded yet'
        : ', data since ' + new Date(report.earliest).toDateString()),
  );
  lines.push('');

  if (options.stores && options.stores.length > 0) {
    lines.push('reading: ' + options.stores.join(', '));
    lines.push('');
  }

  const rows: [string, (window: UsageWindow) => string][] = [
    ['sessions', (w) => formatNumber(w.sessions)],
    ['results judged', (w) => formatNumber(w.judged)],
    ['results replaced', (w) => formatNumber(w.replaced)],
    ['  replaced share', (w) => (w.judged === 0 ? '0%' : Math.round((w.replaced / w.judged) * 100) + '%')],
    ['characters dropped', (w) => formatNumber(w.charsDropped)],
    ['  roughly tokens', (w) => '~' + formatNumber(Math.round(w.charsDropped / 4))],
  ];

  if (report.logLines > 0) {
    rows.push(
      ['Jev calls', (w) => formatNumber(w.jevCalls)],
      ['prompt guard runs', (w) => formatNumber(w.guardRuns)],
      ['  prompts flagged', (w) => formatNumber(w.guardFlags)],
      ['key warnings', (w) => formatNumber(w.keyWarnings)],
    );
  }

  const labelWidth = Math.max(...rows.map(([label]) => label.length));
  const cells = rows.map(([, value]) => report.windows.map(value));
  const valueWidth = Math.max(
    ...cells.flat().map((cell) => cell.length),
    ...report.windows.map((w) => w.label.length),
  );

  lines.push(
    '  ' + ' '.repeat(labelWidth) +
      report.windows.map((w) => w.label.padStart(valueWidth + 2)).join(''),
  );
  rows.forEach(([label], index) => {
    lines.push(
      '  ' + label.padEnd(labelWidth) +
        cells[index]!.map((cell) => cell.padStart(valueWidth + 2)).join(''),
    );
  });

  if (report.logLines === 0) {
    lines.push('');
    lines.push('Jev calls, prompt guard runs and key warnings need debug: true in the plugin config.');
  }
  return lines.join('\n');
}

function readLines(path: string): RawRecord[] {
  try {
    const out: RawRecord[] = [];
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (line.trim().length === 0) continue;
      try {
        out.push(JSON.parse(line) as RawRecord);
      } catch {
        // a corrupt line costs one record, never the report
      }
    }
    return out;
  } catch {
    return [];
  }
}

function readStore(root: string): UsageInput {
  const sessionsDir = join(root, 'sessions');
  const sessions: SessionData[] = [];
  try {
    for (const name of readdirSync(sessionsDir)) {
      if (!name.endsWith('.results.jsonl')) continue;
      sessions.push({
        sessionId: name.slice(0, -'.results.jsonl'.length),
        entries: readLines(join(sessionsDir, name)),
      });
    }
  } catch {
    // no sessions yet
  }
  return { sessions, events: readLines(join(root, 'log', 'events.jsonl')) };
}

/**
 * Reads the active plugin data directory. With all, every sibling store is
 * merged too, which picks up history from an install that has since moved.
 */
function siblingStores(parent: string): string[] {
  try {
    return readdirSync(parent)
      .filter((name) => name.startsWith('codex-context-diet-'))
      .map((name) => join(parent, name));
  } catch {
    return [];
  }
}

export function readUsageInput(env: NodeJS.ProcessEnv, options: { all?: boolean } = {}): UsageInput {
  const configured = env.PLUGIN_DATA ?? env.CLAUDE_PLUGIN_DATA;
  let roots: string[];
  if (configured) {
    roots = [pluginDataDir(env)];
    if (options.all) roots.push(...siblingStores(dirname(pluginDataDir(env))));
  } else {
    // Without PLUGIN_DATA the CLI is being run by hand rather than from a
    // hook, so report every store the plugin wrote instead of an empty fallback.
    roots = siblingStores(join(env.HOME ?? '.', '.codex', 'plugins', 'data'));
  }
  const merged: UsageInput = { sessions: [], events: [] };
  const unique = [...new Set(roots)].filter((root) => existsSync(root));
  for (const root of unique) {
    const part = readStore(root);
    const prefix = unique.length > 1 ? basename(root) + '/' : '';
    merged.sessions.push(...part.sessions.map((s) => ({ ...s, sessionId: prefix + s.sessionId })));
    merged.events.push(...part.events);
  }
  merged.stores = unique.map((root) => basename(root));
  return merged;
}
