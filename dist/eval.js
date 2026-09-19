import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG } from './config.js';
import { runDiet } from './codex/diet.js';
import { createAsker, testAsker } from './codex/transport.js';
import { resolveApiKey } from './key.js';
/**
 * The decision evaluation framework.
 *
 * Offline mode feeds each case the signals a correct Jev answer would give, so
 * the deterministic pipeline is tested for regressions without a network. Live
 * mode asks the real model and reports the same metrics plus tokens and cost.
 * Every fixture declares its expected action, and a false drop fails offline CI.
 */
export const EVAL_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'evals');
export function loadCases(root = EVAL_ROOT) {
    const raw = JSON.parse(readFileSync(join(root, 'cases.json'), 'utf8'));
    return raw.cases;
}
/** `{{FILL:n}}` becomes n benign lines, so a huge log stays a small fixture file. */
export function expandFixture(text) {
    return text
        .split('\n')
        .map((line) => {
        const match = /^\{\{FILL:(\d+)\}\}$/.exec(line.trim());
        if (match === null)
            return line;
        const count = Number(match[1]);
        return Array.from({ length: count }, (_, index) => 'info: routine output line ' + (index + 1)).join('\n');
    })
        .join('\n');
}
export function readFixture(name, root = EVAL_ROOT) {
    return expandFixture(readFileSync(join(root, 'fixtures', name), 'utf8'));
}
const seed = {
    tool_use_id: 'seed', tool_name: 'Read', at: '2026-09-19T00:00:00.000Z', input: 'src/seed.ts',
    head: 'digest', tail: '', chars: 20, decision: 'keep', goal_index: 0,
};
function percentile(values, fraction) {
    if (values.length === 0)
        return 0;
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}
export async function runEvaluation(options = {}) {
    const root = options.root ?? EVAL_ROOT;
    const env = options.env ?? process.env;
    const live = options.live === true;
    const config = { ...DEFAULT_CONFIG, minTokens: 0, chunkRelevance: false };
    const cases = loadCases(root);
    let asker;
    if (live) {
        const { key } = resolveApiKey(config, env);
        if (key === null)
            throw new Error('no TypeSafe API key: set TYPESAFE_API_KEY or write ~/.typesafe_key');
        asker = createAsker(config, key, env);
    }
    else {
        asker = testAsker({ '*': 0.5 });
    }
    const results = [];
    for (const item of cases) {
        const resultText = readFixture(item.fixture, root);
        const caseAsker = live ? asker : testAsker(item.signals);
        const started = performance.now();
        const outcome = await runDiet({
            input: {
                toolName: item.tool,
                toolUseId: item.id,
                inputLine: item.input,
                resultText,
                isError: false,
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
        });
    }
    const expectedDrops = cases.filter((item) => item.expectedAction === 'drop').length;
    const expectedKeeps = cases.length - expectedDrops;
    const predictedDrops = results.filter((item) => item.actual === 'drop').length;
    const falseDrops = results.filter((item) => item.expected === 'keep' && item.actual === 'drop').length;
    const falseKeeps = results.filter((item) => item.expected === 'drop' && item.actual === 'keep').length;
    const trueDrops = predictedDrops - falseDrops;
    const keptExpected = expectedKeeps - falseDrops;
    const compressions = results.map((item) => item.actual === 'drop' ? Math.max(0, 1 - item.noteChars / Math.max(1, item.resultChars)) : 0);
    const sortedCompressions = [...compressions].sort((left, right) => left - right);
    const tokens = results.reduce((sum, item) => sum + (item.inputTokens ?? 0), 0);
    const times = results.map((item) => item.ms);
    return {
        mode: live ? 'live' : 'offline',
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
            compressionMedian: sortedCompressions.length === 0
                ? 0
                : sortedCompressions[Math.floor(sortedCompressions.length / 2)],
            jevCalls: live ? results.length : results.length,
            jevTokens: tokens,
            estimatedCostUsd: (tokens * config.pricePerMillionInputTokens) / 1_000_000,
            p50Ms: percentile(times, 0.5),
            p95Ms: percentile(times, 0.95),
        },
    };
}
const percent = (value) => (value * 100).toFixed(1) + '%';
export function renderEvalReport(report) {
    const lines = [
        'Context Diet decision evaluation (' + report.mode + ')',
        '',
    ];
    for (const item of report.cases) {
        const ok = item.expected === item.actual;
        lines.push((ok ? 'ok  ' : 'miss') + ' [' + item.category + '] ' + item.id + ' -> ' + item.actual + (ok ? '' : ' (expected ' + item.expected + ')'));
    }
    const metrics = report.metrics;
    lines.push('', 'cases:            ' + metrics.cases, 'correct:          ' + metrics.correct, 'false keeps:      ' + metrics.falseKeeps, 'false drops:      ' + metrics.falseDrops + '  (wrong-drop rate ' + percent(metrics.wrongDropRate) + ')', 'drop precision:   ' + percent(metrics.dropPrecision), 'keep recall:      ' + percent(metrics.keepRecall), 'replacement rate: ' + percent(metrics.replacementRate), 'compression:      mean ' + percent(metrics.compressionMean) + ', median ' + percent(metrics.compressionMedian), 'Jev calls:        ' + metrics.jevCalls + (report.mode === 'offline' ? ' (offline: provided signals)' : ''), 'Jev tokens:       ' + metrics.jevTokens, 'estimated cost:   $' + metrics.estimatedCostUsd.toFixed(6), 'latency:          p50 ' + metrics.p50Ms.toFixed(1) + ' ms, p95 ' + metrics.p95Ms.toFixed(1) + ' ms');
    return lines.join('\n');
}
//# sourceMappingURL=eval.js.map