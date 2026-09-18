import { applyDecisions, batchCalls, decideCall, messageChars, reductionRatio } from './decide.js';
import { buildNote, decideDiet } from './codex/diet.js';
import { DEFAULT_CONFIG } from './config.js';
import { dietQuestions, Q_AGENT_DIRECTED, Q_BEHAVIOUR_CHANGE, Q_KEEP_CALL, Q_NEEDS_CONTENTS, Q_REPLACEABLE, } from './questions.js';
import { noulAnswer } from './request.js';
import { collectToolCalls, estimateTokens, fitState } from './state.js';
const PRESERVE = 0;
const MAX_STATE_TOKENS = 25_000;
const MAX_REQUEST_TOKENS = 30_000;
const LOG_LINE = 'npm test output line\n';
export function sampleLog() {
    return LOG_LINE.repeat(400);
}
function msg(role, text, extra = {}) {
    return { role, text, toolUses: [], ...extra };
}
/** A goal, three tool calls, and one bulky failing result. Nothing here costs money. */
export function sampleTranscript() {
    return [
        msg('user', 'Fix the failing test in b.ts without touching generated files.'),
        msg('assistant', '', { toolUses: [{ tool_use_id: 'a', tool: 'Read', input: { file_path: 'src/a.ts' } }] }),
        msg('user', '', { toolResults: [{ tool_use_id: 'a', text: 'export const a = 1;\n'.repeat(50) }] }),
        msg('assistant', '', { toolUses: [{ tool_use_id: 'b', tool: 'Bash', input: { command: 'npm test' } }] }),
        msg('user', '', { toolResults: [{ tool_use_id: 'b', text: sampleLog(), isError: true }] }),
        msg('assistant', '', { toolUses: [{ tool_use_id: 'c', tool: 'Read', input: { file_path: 'src/b.ts' } }] }),
        msg('user', '', { toolResults: [{ tool_use_id: 'c', text: 'export const b = 2;\n'.repeat(50) }] }),
        msg('assistant', 'b.ts is the failure; fixing now.'),
    ];
}
/** Deterministic asker for tests and offline runs. '*' is the fallback score. */
export function fakeAsker(scores) {
    return {
        async ask(_state, questions) {
            return {
                answers: Object.fromEntries(Object.keys(questions).map((key) => [
                    key,
                    { type: 'noul', noul: scores[key] ?? scores['*'] ?? 0.5 },
                ])),
            };
        },
    };
}
/** An asker that always throws, to prove the paths that must not reach the network. */
export function throwingAsker(message) {
    return { ask: () => Promise.reject(new Error(message)) };
}
/** Offline proof that the decision path is wired correctly. Never touches the network. */
export async function verifyCompaction(deps) {
    const checks = [];
    const record = (name, ok, detail) => {
        checks.push({ name, ok, detail });
        return ok;
    };
    const attempt = (name, run) => {
        try {
            return record(name, true, run());
        }
        catch (error) {
            return record(name, false, error instanceof Error ? error.message : String(error));
        }
    };
    const messages = sampleTranscript();
    const calls = collectToolCalls(messages, PRESERVE);
    const charsBefore = messages.reduce((sum, message) => sum + messageChars(message), 0);
    attempt('token-estimator', () => {
        if (estimateTokens('') !== 0)
            throw new Error('the empty string is not free');
        if (estimateTokens('hello world') !== 2)
            throw new Error('word cost changed');
        if (estimateTokens('internationalization') !== 4)
            throw new Error('long-word cost changed');
        if (estimateTokens('12345678') !== 4)
            throw new Error('digit cost changed');
        return 'four calibration cases hold';
    });
    attempt('collect-tool-calls', () => {
        const ids = calls.map((call) => call.id).join(',');
        if (ids !== 't1,t2,t3')
            throw new Error('ids are ' + ids);
        if (calls[1]?.isError !== true)
            throw new Error('the failing call is not marked as an error');
        if (calls[1]?.resultChars !== sampleLog().length)
            throw new Error('resultChars is wrong');
        return 'three calls paired with their results';
    });
    let stateTokens = 0;
    let state = {};
    attempt('fit-state', () => {
        const fitted = fitState(messages, calls, {
            maxStateTokens: MAX_STATE_TOKENS,
            preserveRecentMessages: PRESERVE,
            goal: '',
        });
        stateTokens = fitted.tokens;
        state = fitted.state;
        const json = JSON.stringify(fitted.state);
        if (json.includes(LOG_LINE.trim()))
            throw new Error('the log body leaked into the state');
        if (!json.includes('Fix the failing test'))
            throw new Error('the goal is missing from the state');
        return fitted.stage + ', about ' + fitted.tokens + ' tokens';
    });
    attempt('batch-calls', () => {
        const order = calls.map((call) => call.id).join(',');
        const batched = batchCalls(calls, stateTokens, MAX_REQUEST_TOKENS)
            .flat()
            .map((call) => call.id)
            .join(',');
        if (batched !== order)
            throw new Error('the order changed: ' + batched);
        return 'all questions fit one request';
    });
    let answers = null;
    try {
        const response = await deps.asker.ask(state, dietQuestions({ tool: 'Bash', inputLine: 'npm test', resultChars: sampleLog().length }, true));
        answers = {
            keepCall: noulAnswer(response.answers, Q_KEEP_CALL),
            needsContents: noulAnswer(response.answers, Q_NEEDS_CONTENTS),
            replaceable: noulAnswer(response.answers, Q_REPLACEABLE),
            injection: Math.max(noulAnswer(response.answers, Q_AGENT_DIRECTED), noulAnswer(response.answers, Q_BEHAVIOUR_CHANGE)),
        };
        record('asker-contract', true, 'five noul answers parsed: ' + JSON.stringify(answers));
    }
    catch (error) {
        record('asker-contract', false, error instanceof Error ? error.message : String(error));
    }
    try {
        if (answers === null)
            throw new Error('no answers to decide with');
        const high = decideCall(calls[1], { keepCall: 0.9, keepResult: 0.9 }, 0.5);
        const low = decideCall(calls[1], { keepCall: 0.1, keepResult: 0.1 }, 0.5);
        if (high.action !== 'keep')
            throw new Error('two high scores did not keep');
        if (low.action !== 'drop_call')
            throw new Error('two low scores did not drop the call');
        const flagged = decideDiet({ keepCall: 0.9, needsContents: 0.1, replaceable: 0.9, injection: 0.9 }, DEFAULT_CONFIG);
        if (flagged.action !== 'keep')
            throw new Error('an injection flag did not force keep');
        const dietLow = decideDiet({ keepCall: 0.1, needsContents: 0.1, replaceable: 0.9, injection: 0 }, DEFAULT_CONFIG);
        if (dietLow.action !== 'drop_result')
            throw new Error('the hook treated two low scores as a keep');
        const band = decideDiet({ keepCall: 0.9, needsContents: 0.4, replaceable: 0.9, injection: 0 }, DEFAULT_CONFIG);
        if (band.action !== 'keep')
            throw new Error('the uncertain band did not resolve to keep');
        const input = {
            toolName: 'Bash',
            toolUseId: 'b',
            inputLine: 'npm test',
            resultText: sampleLog(),
            isError: true,
            goalIndex: 0,
        };
        const noted = buildNote(input, decideDiet({ keepCall: 0.9, needsContents: 0.1, replaceable: 0.9, injection: 0 }, DEFAULT_CONFIG), DEFAULT_CONFIG);
        const bare = buildNote(input, dietLow, DEFAULT_CONFIG);
        if (!noted || !noted.includes('Ran:'))
            throw new Error('a kept call lost its one-line note');
        if (!bare || bare.includes('Ran:'))
            throw new Error('a dropped call still names the command');
        record('decide-call', true, 'keep, drop, injection-forces-keep and both notes hold');
    }
    catch (error) {
        record('decide-call', false, error instanceof Error ? error.message : String(error));
    }
    const decisions = [
        decideCall(calls[0], { keepCall: 0.9, keepResult: 0.9 }, 0.5),
        decideCall(calls[1], { keepCall: 0.1, keepResult: 0.1 }, 0.5),
        decideCall(calls[2], { keepCall: 0.9, keepResult: 0.1 }, 0.5),
    ];
    let charsAfter = charsBefore;
    attempt('apply-decisions', () => {
        const kept = applyDecisions(messages, decisions, calls, 200);
        const json = JSON.stringify(kept);
        if (json.includes(LOG_LINE.trim()))
            throw new Error('the dropped result survived');
        if (!json.includes('[codex-context-diet truncated'))
            throw new Error('the truncated result has no note');
        if (kept[0] !== messages[0])
            throw new Error('an untouched message was rebuilt');
        charsAfter = kept.reduce((sum, message) => sum + messageChars(message), 0);
        return kept.length + ' messages, ' + charsAfter + ' chars';
    });
    attempt('reduction', () => {
        const reduction = reductionRatio({ stats: { charsBefore, charsAfter } });
        if (!(charsAfter < charsBefore))
            throw new Error('the result did not shrink');
        if (!(reduction > 0))
            throw new Error('the reduction ratio is not positive');
        return Math.round(reduction * 100) + '% of characters removed';
    });
    return {
        ok: checks.every((check) => check.ok),
        checks,
        stats: {
            charsBefore,
            charsAfter,
            reduction: reductionRatio({ stats: { charsBefore, charsAfter } }),
            stateTokens,
        },
    };
}
//# sourceMappingURL=verify.js.map