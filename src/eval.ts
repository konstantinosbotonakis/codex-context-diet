import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, type DietConfig } from './config.js';
import { runDiet } from './codex/diet.js';
import { configuredAsker, testAsker } from './codex/transport.js';
import type { CacheEntry } from './cache.js';
import { redactText } from './privacy.js';
import type { JevAsker } from './types.js';

/**
 * The decision evaluation framework.
 *
 * Offline mode feeds each case the signals a correct Jev answer would give, so
 * the deterministic pipeline is tested for regressions without a network. Live
 * mode asks the real model and reports the same metrics plus tokens and cost.
 * Every fixture declares its expected action, and a false drop fails offline CI.
 */
export const EVAL_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'evals');

export interface EvalCase {
  id: string;
  category: string;
  goal: string;
  tool: string;
  input: string;
  fixture: string;
  expectedAction: 'keep' | 'drop';
  reason: string;
  /** The scores a correct Jev answer would return, for the offline run. */
  signals: Record<string, number>;
}

export interface EvalCaseResult {
  id: string;
  category: string;
  expected: 'keep' | 'drop';
  actual: 'keep' | 'drop';
  reason: string;
  resultChars: number;
  noteChars: number;
  inputTokens: number | null;
  ms: number;
  /** The raw model answers, when the caller asked for a dump (calibration). */
  answers?: Record<string, Record<string, number | string>>;
}

export interface EvalMetrics {
  cases: number;
  correct: number;
  falseKeeps: number;
  falseDrops: number;
  dropPrecision: number;
  keepRecall: number;
  wrongDropRate: number;
  replacementRate: number;
  compressionMean: number;
  compressionMedian: number;
  jevCalls: number;
  jevTokens: number;
  estimatedCostUsd: number;
  p50Ms: number;
  p95Ms: number;
  /** Exact one-sided 95% upper bound on the false-drop rate for this sample. */
  falseDropUpper95: number;
}

export interface EvalReport {
  mode: 'offline' | 'live';
  /** The model asked in live mode, or null when the signals were simulated. */
  model: string | null;
  cases: EvalCaseResult[];
  metrics: EvalMetrics;
}

export function loadCases(root = EVAL_ROOT): EvalCase[] {
  const raw = JSON.parse(readFileSync(join(root, 'cases.json'), 'utf8')) as { cases: EvalCase[] };
  return raw.cases;
}

/** `{{FILL:n}}` becomes n benign lines, so a huge log stays a small fixture file. */
export function expandFixture(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const match = /^\{\{FILL:(\d+)\}\}$/.exec(line.trim());
      if (match === null) return line;
      const count = Number(match[1]);
      return Array.from({ length: count }, (_, index) => 'info: routine output line ' + (index + 1)).join('\n');
    })
    .join('\n');
}

export function readFixture(name: string, root = EVAL_ROOT): string {
  return expandFixture(readFileSync(join(root, 'fixtures', name), 'utf8'));
}

const seed: CacheEntry = {
  tool_use_id: 'seed', tool_name: 'Read', at: '2026-09-19T00:00:00.000Z', input: 'src/seed.ts',
  head: 'digest', tail: '', chars: 20, decision: 'keep', goal_index: 0,
};

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] as number;
}

export interface EvalOptions {
  live?: boolean;
  env?: NodeJS.ProcessEnv;
  root?: string;
  /** Record the raw answers for every case, for threshold calibration. */
  dump?: boolean;
}

export async function runEvaluation(options: EvalOptions = {}): Promise<EvalReport> {
  const root = options.root ?? EVAL_ROOT;
  const env = options.env ?? process.env;
  const live = options.live === true;
  // The configured provider answers the live run; the corpus only pins the
  // knobs that would otherwise skip cases.
  const config: DietConfig = { ...loadConfig(env), minTokens: 0, chunkRelevance: false };
  const cases = loadCases(root);
  let asker: JevAsker;
  if (live) {
    const configured = configuredAsker(config, env);
    if (configured === null) throw new Error('no TypeSafe API key: set TYPESAFE_API_KEY or write ~/.typesafe_key');
    asker = configured;
  } else {
    asker = testAsker({ '*': 0.5 });
  }

  const results: EvalCaseResult[] = [];
  for (const item of cases) {
    const resultText = readFixture(item.fixture, root);
    let captured: Record<string, Record<string, number | string>> | undefined;
    const baseAsker = live ? asker : testAsker(item.signals);
    const caseAsker = options.dump === true
      ? {
          async ask(state: unknown, questions: Record<string, unknown>) {
            const response = await baseAsker.ask(state as never, questions as never);
            captured = Object.fromEntries(
              Object.entries(response.answers ?? {}).map(([id, answer]) => {
                const record = answer as unknown as Record<string, unknown>;
                const slim: Record<string, number | string> = {};
                for (const key of ['noul', 'choice', 'score', 'confidence']) {
                  const value = record[key];
                  if (typeof value === 'number' || typeof value === 'string') slim[key] = value;
                }
                return [id, slim];
              }),
            );
            return response;
          },
        }
      : baseAsker;
    const started = performance.now();
    const outcome = await runDiet({
      input: {
        toolName: item.tool,
        toolUseId: item.id,
        inputLine: item.input,
        resultText,
        isError: false,
        redacted: redactText(resultText, 'strict').findings > 0,
        goalIndex: 0,
      },
      config,
      cache: [seed],
      asker: caseAsker,
      goal: item.goal,
      firstResult: false,
    });
    const ms = performance.now() - started;
    results.push({
      id: item.id,
      category: item.category,
      expected: item.expectedAction,
      actual: outcome.decision.action === 'drop_result' ? 'drop' : 'keep',
      reason: item.reason,
      resultChars: resultText.length,
      noteChars: outcome.note === null ? resultText.length : outcome.note.length,
      inputTokens: outcome.inputTokens,
      ms,
      ...(captured === undefined ? {} : { answers: captured }),
    });
  }

  const expectedDrops = cases.filter((item) => item.expectedAction === 'drop').length;
  const expectedKeeps = cases.length - expectedDrops;
  const predictedDrops = results.filter((item) => item.actual === 'drop').length;
  const falseDrops = results.filter((item) => item.expected === 'keep' && item.actual === 'drop').length;
  const falseKeeps = results.filter((item) => item.expected === 'drop' && item.actual === 'keep').length;
  const trueDrops = predictedDrops - falseDrops;
  const keptExpected = expectedKeeps - falseDrops;
  const compressions = results.map((item) =>
    item.actual === 'drop' ? Math.max(0, 1 - item.noteChars / Math.max(1, item.resultChars)) : 0,
  );
  const sortedCompressions = [...compressions].sort((left, right) => left - right);
  const tokens = results.reduce((sum, item) => sum + (item.inputTokens ?? 0), 0);
  const times = results.map((item) => item.ms);

  return {
    mode: live ? 'live' : 'offline',
    model: live
      ? config.provider === 'laya'
        ? 'laya/' + config.layaModel + (config.layaSubfolder.length > 0 ? '/' + config.layaSubfolder : '')
        : config.model
      : null,
    cases: results,
    metrics: {
      cases: cases.length,
      correct: cases.length - falseDrops - falseKeeps,
      falseKeeps,
      falseDrops,
      dropPrecision: predictedDrops === 0 ? 1 : trueDrops / predictedDrops,
      keepRecall: expectedKeeps === 0 ? 1 : keptExpected / expectedKeeps,
      wrongDropRate: cases.length === 0 ? 0 : falseDrops / cases.length,
      replacementRate: cases.length === 0 ? 0 : predictedDrops / cases.length,
      compressionMean: compressions.length === 0 ? 0 : compressions.reduce((sum, value) => sum + value, 0) / compressions.length,
      compressionMedian:
        sortedCompressions.length === 0
          ? 0
          : (sortedCompressions[Math.floor(sortedCompressions.length / 2)] as number),
      jevCalls: live ? results.length : results.length,
      jevTokens: tokens,
      // A local model has no metered cost; only the hosted provider does.
      estimatedCostUsd:
        config.provider === 'laya' ? 0 : (tokens * config.pricePerMillionInputTokens) / 1_000_000,
      p50Ms: percentile(times, 0.5),
      p95Ms: percentile(times, 0.95),
      falseDropUpper95: falseDropUpperBound(falseDrops, cases.length),
    },
  };
}

const percent = (value: number): string => (value * 100).toFixed(1) + '%';

/**
 * Exact one-sided upper bound for the failure rate: the p where
 * P(X <= failures) equals 1 - confidence. Bisection over the binomial CDF,
 * so a zero-failure sample reports 1 - 0.05^(1/n) rather than zero risk.
 */
export function falseDropUpperBound(failures: number, cases: number, confidence = 0.95): number {
  if (cases <= 0) return 1;
  if (failures >= cases) return 1;
  const alpha = 1 - confidence;
  const cdf = (p: number): number => {
    if (p <= 0) return failures === 0 ? 1 : 0;
    if (p >= 1) return failures >= cases ? 1 : 0;
    let term = Math.pow(1 - p, cases);
    let sum = term;
    for (let index = 0; index < failures; index += 1) {
      term *= ((cases - index) / (index + 1)) * (p / (1 - p));
      sum += term;
    }
    return sum;
  };
  let low = 0;
  let high = 1;
  for (let index = 0; index < 60; index += 1) {
    const mid = (low + high) / 2;
    if (cdf(mid) > alpha) low = mid;
    else high = mid;
  }
  return high;
}

export function renderEvalReport(report: EvalReport): string {
  const lines: string[] = [
    'Context Diet decision evaluation',
    'Mode: ' + (report.mode === 'offline' ? 'OFFLINE POLICY REGRESSION' : 'LIVE JEV EVALUATION'),
    report.mode === 'offline'
      ? 'Jev predictions: simulated from the fixture labels'
      : 'Model: ' + (report.model ?? 'configured model'),
    '',
  ];
  for (const item of report.cases) {
    const ok = item.expected === item.actual;
    lines.push((ok ? 'ok  ' : 'miss') + ' [' + item.category + '] ' + item.id + ' -> ' + item.actual + (ok ? '' : ' (expected ' + item.expected + ')'));
  }
  const metrics = report.metrics;
  lines.push(
    '',
    'cases:            ' + metrics.cases,
    'correct:          ' + metrics.correct,
    'false keeps:      ' + metrics.falseKeeps,
    'false drops:      ' + metrics.falseDrops,
    (report.mode === 'offline' ? 'policy drop rate: ' : 'observed drop rate: ') + percent(metrics.wrongDropRate),
    '95% upper bound:  ' + percent(metrics.falseDropUpper95) + '  (exact one-sided binomial)',
    'drop precision:   ' + percent(metrics.dropPrecision),
    'keep recall:      ' + percent(metrics.keepRecall),
    'replacement rate: ' + percent(metrics.replacementRate),
    'compression:      mean ' + percent(metrics.compressionMean) + ', median ' + percent(metrics.compressionMedian),
    'Jev calls:        ' + metrics.jevCalls + (report.mode === 'offline' ? ' (offline: provided signals)' : ''),
    'Jev tokens:       ' + metrics.jevTokens,
    'estimated cost:   $' + metrics.estimatedCostUsd.toFixed(6),
    'latency:          p50 ' + metrics.p50Ms.toFixed(1) + ' ms, p95 ' + metrics.p95Ms.toFixed(1) + ' ms',
  );
  if (metrics.falseDrops === 0) {
    lines.push(
      '',
      'Zero observed false drops is not zero risk. With ' + metrics.cases + ' cases the 95% upper',
      'bound above is the honest number; a bound near 1% needs roughly 300 zero-failure cases.',
    );
  }
  return lines.join('\n');
}
