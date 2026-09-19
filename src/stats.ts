import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { JEV_INPUT_PRICE_PER_MTOK, pluginDataDir } from './config.js';
import { DUPLICATE_REASON } from './dedupe.js';
import { JEV_REASONS } from './codex/diet.js';

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
  /** USD per million input tokens, read from the store config when it is there. */
  pricePerMillionInputTokens?: number;
}

export interface UsageWindow {
  label: string;
  start: number;
  sessions: number;
  judged: number;
  replaced: number;
  charsDropped: number;
  jevCalls: number;
  jevTokens: number;
  /** Jev calls in this window whose API response reported token usage. */
  jevMeasured: number;
  costUsd: number;
  guardRuns: number;
  guardFlags: number;
  keyWarnings: number;
  /** Results removed because the session already held an identical one. */
  deterministicDrops: number;
  /** Results the adapter looked at and left alone before any decision. */
  entries: number;
  skipped: number;
  keeps: number;
  neededKeeps: number;
  uncertainKeeps: number;
  irreplaceableKeeps: number;
  hazardKeeps: number;
  /** Drops decided by a Jev answer, as opposed to a deterministic rule. */
  semanticDrops: number;
  /** Characters the model still carries in capsules that replaced results. */
  capsuleChars: number;
  redactions: number;
  qualityInterventions: number;
  subagentChecks: number;
  subagentRevisions: number;
  /** Characters put back into context by re-runs of dropped output. */
  recoveryChars: number;
  dietP50: number;
  dietP95: number;
  /** Later calls that look like they re-ran a dropped result. */
  recoveryReruns: number;
  /** Sum of the tool calls between those drops and their reruns. */
  recoveryCalls: number;
}

export interface UsageReport {
  windows: UsageWindow[];
  earliest: number | null;
  logLines: number;
  pricePerMillionInputTokens: number;
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
  pricePerMillionInputTokens: number = JEV_INPUT_PRICE_PER_MTOK,
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
    jevTokens: 0,
    jevMeasured: 0,
    costUsd: 0,
    guardRuns: 0,
    guardFlags: 0,
    keyWarnings: 0,
    deterministicDrops: 0,
    entries: 0,
    skipped: 0,
    keeps: 0,
    neededKeeps: 0,
    uncertainKeeps: 0,
    irreplaceableKeeps: 0,
    hazardKeeps: 0,
    semanticDrops: 0,
    capsuleChars: 0,
    redactions: 0,
    qualityInterventions: 0,
    subagentChecks: 0,
    subagentRevisions: 0,
    recoveryChars: 0,
    dietP50: 0,
    dietP95: 0,
    recoveryReruns: 0,
    recoveryCalls: 0,
  }));
  const seen = windows.map(() => new Set<string>());
  const latencies = windows.map(() => [] as number[]);
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
        window.entries += 1;
        seen[index]!.add(session.sessionId);
        const chars = typeof entry.chars === 'number' ? entry.chars : 0;
        const kept = typeof entry.keptChars === 'number' ? entry.keptChars : 0;
        const reason = typeof entry.reason === 'string' ? entry.reason : '';
        if (entry.decision === 'drop_result') {
          window.replaced += 1;
          window.charsDropped += chars;
          window.capsuleChars += kept;
          if (reason === JEV_REASONS.stale) window.semanticDrops += 1;
          else if (reason === DUPLICATE_REASON) window.deterministicDrops += 1;
        } else {
          window.keeps += 1;
          if (reason === JEV_REASONS.hazard) window.hazardKeeps += 1;
          else if (reason === JEV_REASONS.needed) window.neededKeeps += 1;
          else if (reason === JEV_REASONS.irreplaceable) window.irreplaceableKeeps += 1;
          else if (reason === JEV_REASONS.uncertain) window.uncertainKeeps += 1;
        }
      });
    }
  }

  for (const event of input.events) {
    const when = timestamp(event);
    if (when === null) continue;
    const kind = String(event.kind ?? 'diet');
    const reason = String(event.reason ?? '');
    const tokens =
      typeof event.inputTokens === 'number' && Number.isFinite(event.inputTokens) ? event.inputTokens : null;
    bump(when, (window, index) => {
      if (tokens !== null) window.jevTokens += tokens;
      if (kind === 'recovery') {
        window.recoveryReruns += 1;
        if (typeof event.afterCalls === 'number' && Number.isFinite(event.afterCalls)) {
          window.recoveryCalls += event.afterCalls;
        }
        if (typeof event.chars === 'number' && Number.isFinite(event.chars)) {
          window.recoveryChars += event.chars;
        }
        return;
      }
      if (kind === 'skip') {
        window.skipped += 1;
        return;
      }
      if (kind === 'privacy' && event.action === 'redacted') {
        const findings = typeof event.findings === 'number' && Number.isFinite(event.findings) ? event.findings : 0;
        window.redactions += findings;
        return;
      }
      if (kind === 'quality_verdict') {
        if (event.action === 'continue') window.qualityInterventions += 1;
        return;
      }
      if (kind === 'subagent_stop') {
        window.subagentChecks += 1;
        return;
      }
      if (kind === 'subagent_verdict') {
        if (event.action === 'revise') window.subagentRevisions += 1;
        return;
      }
      if (typeof event.ms === 'number' && Number.isFinite(event.ms)) {
        latencies[index]!.push(event.ms);
      }
      if (kind === 'prompt_guard') {
        window.guardRuns += 1;
        if (event.flagged === true) window.guardFlags += 1;
        if (event.asked === true) {
          window.jevCalls += 1;
          if (tokens !== null) window.jevMeasured += 1;
        }
        return;
      }
      if (kind === 'key_missing' || kind === 'key_rejected') {
        window.keyWarnings += 1;
        return;
      }
      if (jevReasons.includes(reason)) {
        window.jevCalls += 1;
        if (tokens !== null) window.jevMeasured += 1;
      }
    });
  }

  return {
    windows: windows.map((window, index) => ({
      ...window,
      sessions: seen[index]!.size,
      dietP50: percentile(latencies[index]!, 0.5),
      dietP95: percentile(latencies[index]!, 0.95),
      costUsd: (window.jevTokens * pricePerMillionInputTokens) / 1_000_000,
    })),
    earliest,
    logLines: input.events.length,
    pricePerMillionInputTokens,
  };
}

function formatNumber(value: number): string {
  return value.toLocaleString('en-US');
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] as number);
}

/** Dollars, precise enough for the fractions of a cent a small request costs. */
function formatCost(value: number): string {
  if (value === 0) return '$0';
  if (value < 0.0001) return '<$0.0001';
  return '$' + value.toFixed(value >= 1 ? 2 : 4);
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
    ['results seen', (w) => formatNumber(w.entries + w.skipped)],
    ['  results skipped', (w) => formatNumber(w.skipped)],
    ['results judged', (w) => formatNumber(w.judged)],
    ['results replaced', (w) => formatNumber(w.replaced)],
    ['  replaced share', (w) => (w.judged === 0 ? '0%' : Math.round((w.replaced / w.judged) * 100) + '%')],
    ['keeps', (w) => formatNumber(w.keeps)],
    ['  uncertain keeps', (w) => formatNumber(w.uncertainKeeps)],
    ['  irreplaceable keeps', (w) => formatNumber(w.irreplaceableKeeps)],
    ['  hazard keeps', (w) => formatNumber(w.hazardKeeps)],
    ['  deterministic drops', (w) => formatNumber(w.deterministicDrops)],
    ['  semantic drops', (w) => formatNumber(w.semanticDrops)],
    ['characters dropped', (w) => formatNumber(w.charsDropped)],
    ['  original tokens', (w) => '~' + formatNumber(Math.round(w.charsDropped / 4))],
    ['  capsule tokens', (w) => '~' + formatNumber(Math.round(w.capsuleChars / 4))],
    ['  net tokens avoided', (w) => '~' + formatNumber(Math.round(Math.max(0, w.charsDropped - w.capsuleChars) / 4))],
  ];

  if (report.logLines > 0) {
    rows.push(
      ['Jev calls', (w) => formatNumber(w.jevCalls)],
      ['prompt guard runs', (w) => formatNumber(w.guardRuns)],
      ['  prompts flagged', (w) => formatNumber(w.guardFlags)],
      ['key warnings', (w) => formatNumber(w.keyWarnings)],
      ['  recovery reruns', (w) => formatNumber(w.recoveryReruns)],
      ['  recovery rate', (w) => (w.replaced === 0 ? '0%' : Math.round((w.recoveryReruns / w.replaced) * 100) + '%')],
      ['  net useful replacements', (w) => formatNumber(Math.max(0, w.replaced - w.recoveryReruns))],
      ['  recovery tokens', (w) => '~' + formatNumber(Math.round(w.recoveryChars / 4))],
      ['Jev input tokens', (w) => formatNumber(w.jevTokens)],
      ['  estimated cost', (w) => formatCost(w.costUsd)],
      ['secret redactions', (w) => formatNumber(w.redactions)],
      ['quality interventions', (w) => formatNumber(w.qualityInterventions)],
      ['subagent checks', (w) => formatNumber(w.subagentChecks)],
      ['  subagent revisions', (w) => formatNumber(w.subagentRevisions)],
      ['diet p50', (w) => (w.dietP50 === 0 ? '0 ms' : w.dietP50 + ' ms')],
      ['  diet p95', (w) => (w.dietP95 === 0 ? '0 ms' : w.dietP95 + ' ms')],
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
  const widest = report.windows[report.windows.length - 1];
  if (widest !== undefined && widest.jevCalls > 0) {
    lines.push('');
    lines.push('Cost uses ' + report.pricePerMillionInputTokens + ' USD per million input tokens, the published Jev input price; output tokens are free.');
    const missing = widest.jevCalls - widest.jevMeasured;
    if (missing > 0) {
      lines.push('Cost is a lower bound: ' + missing + ' call' + (missing === 1 ? '' : 's') + ' recorded no usage.');
    }
  }
  if (widest !== undefined && widest.replaced > 0) {
    lines.push('');
    lines.push('Context saved counts characters the session no longer carries, less the capsule text that replaced them. Jev tokens are a separate resource and are never netted against context.');
  }
  if (widest !== undefined && widest.recoveryReruns > 0) {
    const average = (widest.recoveryCalls / widest.recoveryReruns).toFixed(1);
    lines.push('');
    lines.push('Recoveries were re-run ' + average + ' tool calls after the drop on average. This is inferred from repeated commands and re-reads, so an intentional rerun counts too.');
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

/** The price a store's config sets, when it sets a usable one. */
function readPrice(root: string): number | null {
  try {
    const raw = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8')) as {
      pricePerMillionInputTokens?: unknown;
    };
    const value = raw.pricePerMillionInputTokens;
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  } catch {
    return null;
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
  return {
    sessions,
    events: readLines(join(root, 'log', 'events.jsonl')),
    pricePerMillionInputTokens: readPrice(root) ?? undefined,
  };
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
    if (merged.pricePerMillionInputTokens === undefined && part.pricePerMillionInputTokens !== undefined) {
      merged.pricePerMillionInputTokens = part.pricePerMillionInputTokens;
    }
    const prefix = unique.length > 1 ? basename(root) + '/' : '';
    merged.sessions.push(...part.sessions.map((s) => ({ ...s, sessionId: prefix + s.sessionId })));
    merged.events.push(...part.events);
  }
  merged.stores = unique.map((root) => basename(root));
  return merged;
}
