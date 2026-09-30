/**
 * File scout: bounded local file samples judged by Jev (levels 8-10).
 * Deterministic skips run first; the uncertain band allows read (fail-open).
 */
import { readFileSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { isNeverSendInput, redactText } from './privacy.js';
import { noulAnswer } from './request.js';
import { sampleResult } from './sample.js';
export const FILE_SCOUT_CONTEXT = 'A coding agent is deciding whether to read a source file into its main context window. ' +
    'The sample is bounded and may omit parts of the file. Judge from the sample and path only.';
const GENERATED = /(?:^|\/)(?:dist|node_modules|\.git|coverage|build)(?:\/|$)/i;
const GENERATED_FILE = /(?:package-lock\.json|\.min\.(?:js|css)|\.map)$/i;
function inputTokens(response) {
    const value = response.usage?.input_tokens;
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
export function resolveScoutPath(raw, cwd) {
    const trimmed = raw.trim();
    if (trimmed.length === 0)
        throw new Error('path must not be empty');
    return resolve(isAbsolute(trimmed) ? trimmed : join(cwd, trimmed));
}
function relPath(abs, cwd) {
    const rel = relative(cwd, abs);
    return rel.split(String.fromCharCode(92)).join('/') || basename(abs);
}
function deterministicSkip(rel, config) {
    if (GENERATED.test(rel) || GENERATED_FILE.test(rel))
        return 'generated_or_vendor';
    if (isNeverSendInput('Read', rel, config))
        return 'never_send_path';
    return null;
}
function readSample(absPath, config, maxSampleChars) {
    const text = readFileSync(absPath, 'utf8');
    const budget = Math.max(2000, Math.min(maxSampleChars, config.fileScoutMaxSampleChars));
    const sampled = sampleResult(text, {
        budgetChars: budget,
        headChars: Math.floor(budget / 2),
        tailChars: Math.floor(budget / 5),
    });
    return { sample: redactText(sampled.text, config.privacyMode).text, fileChars: text.length };
}
function valueBand(probability, config) {
    if (probability >= config.fileScoutReadThreshold)
        return 'high';
    if (probability <= config.fileScoutSkipThreshold)
        return 'low';
    return 'medium';
}
function decideBoolean(probability, config) {
    const value = valueBand(probability, config);
    if (probability >= config.fileScoutReadThreshold) {
        return { answer: true, action: 'read', reason: 'jev_above_read_threshold', value };
    }
    if (probability <= config.fileScoutSkipThreshold) {
        return { answer: false, action: 'skip', reason: 'jev_below_skip_threshold', value };
    }
    return { answer: true, action: 'read', reason: 'uncertain_band_allow_read', value };
}
function scoutState(input, rel, sample, goal) {
    return { context: FILE_SCOUT_CONTEXT, goal, path: rel, question: input.question, sample };
}
export async function jevFileBoolean(asker, config, input) {
    const cwd = input.cwd ?? process.cwd();
    const abs = resolveScoutPath(input.path, cwd);
    const rel = relPath(abs, cwd);
    const blocked = deterministicSkip(rel, config);
    if (blocked) {
        return {
            path: rel,
            probability: 0,
            answer: false,
            action: blocked === 'never_send_path' ? 'blocked' : 'deterministic_skip',
            reason: blocked,
            sampleChars: 0,
            fileChars: statSync(abs).size,
            model: null,
            input_tokens: null,
            value: 'none',
        };
    }
    const { sample, fileChars } = readSample(abs, config, input.maxSampleChars ?? config.fileScoutMaxSampleChars);
    const goal = (input.goal ?? '').trim() || 'Understand the codebase and answer the current task.';
    const response = await asker.ask(scoutState(input, rel, sample, goal), {
        relevant: {
            type: 'noul',
            instructions: input.question,
            criteria: {
                true: 'The sample and path suggest this file is needed to answer the goal or question',
                false: 'The sample and path suggest this file can be skipped without losing answerable evidence',
            },
        },
    });
    const probability = noulAnswer(response.answers, 'relevant');
    return {
        path: rel,
        probability,
        ...decideBoolean(probability, config),
        sampleChars: sample.length,
        fileChars,
        model: response.model ?? null,
        input_tokens: inputTokens(response),
    };
}
export async function jevFileChoice(asker, config, input) {
    const options = input.options.filter((item) => item.trim().length > 0);
    if (options.length < 2)
        throw new Error('options needs at least two entries');
    const cwd = input.cwd ?? process.cwd();
    const abs = resolveScoutPath(input.path, cwd);
    const rel = relPath(abs, cwd);
    const blocked = deterministicSkip(rel, config);
    if (blocked) {
        return {
            path: rel,
            choice: null,
            probabilities: null,
            confidence: null,
            action: blocked === 'never_send_path' ? 'blocked' : 'deterministic_skip',
            reason: blocked,
            sampleChars: 0,
            fileChars: statSync(abs).size,
            model: null,
            input_tokens: null,
            value: 'none',
        };
    }
    const { sample, fileChars } = readSample(abs, config, input.maxSampleChars ?? config.fileScoutMaxSampleChars);
    const goal = (input.goal ?? '').trim() || 'Classify this file for planning.';
    const response = await asker.ask(scoutState(input, rel, sample, goal), {
        layer: {
            type: 'choice',
            instructions: input.question,
            criteria: Object.fromEntries(options.map((item) => [item, null])),
        },
    });
    const answer = (response.answers.layer ?? {});
    const choice = typeof answer.choice === 'string' && options.includes(answer.choice) ? answer.choice : null;
    const rawProb = answer.probabilities;
    const probabilities = rawProb && typeof rawProb === 'object' && !Array.isArray(rawProb)
        ? Object.fromEntries(Object.entries(rawProb).filter(([key, value]) => options.includes(key) && typeof value === 'number'))
        : null;
    const confidence = typeof answer.confidence === 'number' ? answer.confidence : null;
    return {
        path: rel,
        choice,
        probabilities,
        confidence,
        action: choice ? 'read' : 'skip',
        reason: choice ? 'choice_selected' : 'no_matching_choice',
        sampleChars: sample.length,
        fileChars,
        model: response.model ?? null,
        input_tokens: inputTokens(response),
        value: choice ? 'high' : 'low',
    };
}
export function expandScoutPaths(rawPaths, cwd, maxFiles) {
    const out = [];
    for (const raw of rawPaths) {
        const trimmed = raw.trim();
        if (trimmed.length === 0)
            continue;
        if (trimmed.includes('*'))
            continue;
        out.push(resolveScoutPath(trimmed, cwd));
        if (out.length >= maxFiles)
            break;
    }
    return [...new Set(out)].slice(0, maxFiles);
}
export async function jevFiles(asker, config, input) {
    if (!config.fileScout) {
        return { question: input.question, goal: input.goal, results: [], skipped: ['fileScout disabled'], jevCalls: 0, input_tokens: 0, model: null };
    }
    const cwd = input.cwd ?? process.cwd();
    const maxFiles = Math.min(input.maxFiles ?? config.fileScoutMaxFiles, config.fileScoutMaxFiles);
    const paths = expandScoutPaths(input.paths, cwd, maxFiles);
    const results = [];
    const skipped = [];
    let tokens = 0;
    let model = null;
    let calls = 0;
    for (const abs of paths) {
        const rel = relPath(abs, cwd);
        const blocked = deterministicSkip(rel, config);
        if (blocked) {
            skipped.push(rel + ' (' + blocked + ')');
            continue;
        }
        calls += 1;
        const one = await jevFileBoolean(asker, config, { path: abs, question: input.question, goal: input.goal, cwd });
        model = one.model ?? model;
        if (typeof one.input_tokens === 'number')
            tokens += one.input_tokens;
        results.push({
            path: one.path,
            probability: one.probability,
            answer: one.answer,
            action: one.action,
            reason: one.reason,
            value: one.value,
        });
    }
    return {
        question: input.question,
        goal: input.goal,
        results,
        skipped,
        jevCalls: calls,
        input_tokens: calls === 0 ? 0 : tokens,
        model,
    };
}
//# sourceMappingURL=fileScout.js.map