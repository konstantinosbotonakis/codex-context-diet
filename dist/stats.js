import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { JEV_INPUT_PRICE_PER_MTOK, pluginDataDir } from './config.js';
import { DUPLICATE_REASON } from './dedupe.js';
export const WINDOWS = [
    { label: 'today', days: 1 },
    { label: '7 days', days: 7 },
    { label: '30 days', days: 30 },
];
/** Local midnight, n days back. setDate rather than millisecond maths, so DST is handled. */
export function localMidnight(now, daysBack) {
    const date = new Date(now.getTime());
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() - daysBack);
    return date.getTime();
}
function timestamp(record) {
    const value = Date.parse(String(record.at ?? ''));
    return Number.isFinite(value) ? value : null;
}
export function summarizeUsage(input, jevReasons, specs = WINDOWS, pricePerMillionInputTokens = JEV_INPUT_PRICE_PER_MTOK) {
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
    }));
    const seen = windows.map(() => new Set());
    let earliest = null;
    const bump = (when, apply) => {
        if (earliest === null || when < earliest)
            earliest = when;
        windows.forEach((window, index) => {
            if (when >= window.start && when <= end)
                apply(window, index);
        });
    };
    for (const session of input.sessions) {
        for (const entry of session.entries) {
            const when = timestamp(entry);
            if (when === null)
                continue;
            bump(when, (window, index) => {
                window.judged += 1;
                seen[index].add(session.sessionId);
                if (entry.decision === 'drop_result') {
                    window.replaced += 1;
                    window.charsDropped += typeof entry.chars === 'number' ? entry.chars : 0;
                }
            });
        }
    }
    for (const event of input.events) {
        const when = timestamp(event);
        if (when === null)
            continue;
        const kind = String(event.kind ?? 'diet');
        const reason = String(event.reason ?? '');
        const tokens = typeof event.inputTokens === 'number' && Number.isFinite(event.inputTokens) ? event.inputTokens : null;
        bump(when, (window) => {
            if (tokens !== null)
                window.jevTokens += tokens;
            if (kind === 'prompt_guard') {
                window.guardRuns += 1;
                if (event.flagged === true)
                    window.guardFlags += 1;
                if (event.asked === true) {
                    window.jevCalls += 1;
                    if (tokens !== null)
                        window.jevMeasured += 1;
                }
                return;
            }
            if (kind === 'key_missing' || kind === 'key_rejected') {
                window.keyWarnings += 1;
                return;
            }
            if (reason === DUPLICATE_REASON) {
                window.deterministicDrops += 1;
                return;
            }
            if (jevReasons.includes(reason)) {
                window.jevCalls += 1;
                if (tokens !== null)
                    window.jevMeasured += 1;
            }
        });
    }
    return {
        windows: windows.map((window, index) => ({
            ...window,
            sessions: seen[index].size,
            costUsd: (window.jevTokens * pricePerMillionInputTokens) / 1_000_000,
        })),
        earliest,
        logLines: input.events.length,
        pricePerMillionInputTokens,
    };
}
function formatNumber(value) {
    return value.toLocaleString('en-US');
}
/** Dollars, precise enough for the fractions of a cent a small request costs. */
function formatCost(value) {
    if (value === 0)
        return '$0';
    if (value < 0.0001)
        return '<$0.0001';
    return '$' + value.toFixed(value >= 1 ? 2 : 4);
}
/** A table of counts. Never prints tool output, prompts, commands, or any other content. */
export function renderUsage(report, options) {
    const now = options.now ?? new Date();
    const localToday = new Date(localMidnight(now, 0));
    const lines = [];
    lines.push('Codex Context Diet, usage on this machine');
    lines.push('today is ' + localToday.toDateString() + ' (' + options.timeZone + ')' +
        (report.earliest === null
            ? ', no data recorded yet'
            : ', data since ' + new Date(report.earliest).toDateString()));
    lines.push('');
    if (options.stores && options.stores.length > 0) {
        lines.push('reading: ' + options.stores.join(', '));
        lines.push('');
    }
    const rows = [
        ['sessions', (w) => formatNumber(w.sessions)],
        ['results judged', (w) => formatNumber(w.judged)],
        ['results replaced', (w) => formatNumber(w.replaced)],
        ['  replaced share', (w) => (w.judged === 0 ? '0%' : Math.round((w.replaced / w.judged) * 100) + '%')],
        ['characters dropped', (w) => formatNumber(w.charsDropped)],
        ['  roughly tokens', (w) => '~' + formatNumber(Math.round(w.charsDropped / 4))],
    ];
    if (report.logLines > 0) {
        rows.push(['Jev calls', (w) => formatNumber(w.jevCalls)], ['prompt guard runs', (w) => formatNumber(w.guardRuns)], ['  prompts flagged', (w) => formatNumber(w.guardFlags)], ['key warnings', (w) => formatNumber(w.keyWarnings)], ['  deterministic drops', (w) => formatNumber(w.deterministicDrops)], ['Jev input tokens', (w) => formatNumber(w.jevTokens)], ['  estimated cost', (w) => formatCost(w.costUsd)]);
    }
    const labelWidth = Math.max(...rows.map(([label]) => label.length));
    const cells = rows.map(([, value]) => report.windows.map(value));
    const valueWidth = Math.max(...cells.flat().map((cell) => cell.length), ...report.windows.map((w) => w.label.length));
    lines.push('  ' + ' '.repeat(labelWidth) +
        report.windows.map((w) => w.label.padStart(valueWidth + 2)).join(''));
    rows.forEach(([label], index) => {
        lines.push('  ' + label.padEnd(labelWidth) +
            cells[index].map((cell) => cell.padStart(valueWidth + 2)).join(''));
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
    return lines.join('\n');
}
function readLines(path) {
    try {
        const out = [];
        for (const line of readFileSync(path, 'utf8').split('\n')) {
            if (line.trim().length === 0)
                continue;
            try {
                out.push(JSON.parse(line));
            }
            catch {
                // a corrupt line costs one record, never the report
            }
        }
        return out;
    }
    catch {
        return [];
    }
}
/** The price a store's config sets, when it sets a usable one. */
function readPrice(root) {
    try {
        const raw = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'));
        const value = raw.pricePerMillionInputTokens;
        return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
    }
    catch {
        return null;
    }
}
function readStore(root) {
    const sessionsDir = join(root, 'sessions');
    const sessions = [];
    try {
        for (const name of readdirSync(sessionsDir)) {
            if (!name.endsWith('.results.jsonl'))
                continue;
            sessions.push({
                sessionId: name.slice(0, -'.results.jsonl'.length),
                entries: readLines(join(sessionsDir, name)),
            });
        }
    }
    catch {
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
function siblingStores(parent) {
    try {
        return readdirSync(parent)
            .filter((name) => name.startsWith('codex-context-diet-'))
            .map((name) => join(parent, name));
    }
    catch {
        return [];
    }
}
export function readUsageInput(env, options = {}) {
    const configured = env.PLUGIN_DATA ?? env.CLAUDE_PLUGIN_DATA;
    let roots;
    if (configured) {
        roots = [pluginDataDir(env)];
        if (options.all)
            roots.push(...siblingStores(dirname(pluginDataDir(env))));
    }
    else {
        // Without PLUGIN_DATA the CLI is being run by hand rather than from a
        // hook, so report every store the plugin wrote instead of an empty fallback.
        roots = siblingStores(join(env.HOME ?? '.', '.codex', 'plugins', 'data'));
    }
    const merged = { sessions: [], events: [] };
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
//# sourceMappingURL=stats.js.map