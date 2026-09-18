import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { appendCache, readCache } from '../cache.js';
import { loadConfig, pluginDataDir } from '../config.js';
import { resolveApiKey } from '../key.js';
import { estimateTokens } from '../state.js';
import { capturePayload } from './capture.js';
import { runDiet } from './diet.js';
import { inputLine, isSkippedTool, toolResultText } from './payload.js';
import { readGoal } from './session.js';
import { createAsker } from './transport.js';
function text(value) {
    return typeof value === 'string' ? value : '';
}
function isErrorResponse(toolResponse) {
    if (!toolResponse || typeof toolResponse !== 'object')
        return false;
    const record = toolResponse;
    return record.is_error === true || record.isError === true;
}
function logEvent(env, config, outcome) {
    if (!config.debug)
        return;
    try {
        const dir = join(pluginDataDir(env), 'log');
        mkdirSync(dir, { recursive: true });
        appendFileSync(join(dir, 'events.jsonl'), JSON.stringify({
            at: new Date().toISOString(),
            tool: outcome.entry.tool_name,
            action: outcome.decision.action,
            reason: outcome.decision.reason,
            keepCall: outcome.decision.keepCall,
            needsContents: outcome.decision.needsContents,
            replaceable: outcome.decision.replaceable,
            injection: outcome.decision.injection,
            chars: outcome.entry.chars,
            blocked: outcome.blocked,
        }) + '\n');
    }
    catch {
        // diagnostics never break the run
    }
}
/** Reads one hook payload and returns at most one stdout object. Never throws. */
export async function main(stdin, env) {
    try {
        capturePayload(env, stdin);
        let payload;
        try {
            const parsed = JSON.parse(stdin);
            if (!parsed || typeof parsed !== 'object')
                return '';
            payload = parsed;
        }
        catch {
            return '';
        }
        if (payload.hook_event_name !== 'PostToolUse')
            return '';
        const config = loadConfig(env);
        if (!config.enabled)
            return '';
        const toolName = text(payload.tool_name);
        if (isSkippedTool(toolName, config))
            return '';
        const resultText = toolResultText(toolName, payload.tool_response);
        if (resultText === null)
            return '';
        if (estimateTokens(resultText) < config.minTokens)
            return '';
        const sessionId = text(payload.session_id);
        // stateSource 'off' is single-turn: no history is read and nothing is written.
        const singleTurn = config.stateSource === 'off';
        const cache = singleTurn ? [] : readCache(env, sessionId, config);
        const { goal, goalIndex } = readGoal(env, sessionId);
        const { key } = resolveApiKey(config, env);
        // CONTEXT_DIET_TEST_ANSWERS is a tests-only transport: it never reaches the
        // network, so it may stand in for a missing key.
        const asker = key !== null || env.CONTEXT_DIET_TEST_ANSWERS
            ? createAsker(config, key ?? 'test-key', env)
            : null;
        const outcome = await runDiet({
            input: {
                toolName,
                toolUseId: text(payload.tool_use_id),
                inputLine: inputLine(toolName, payload.tool_input),
                resultText,
                isError: isErrorResponse(payload.tool_response),
                goalIndex,
            },
            config,
            cache,
            asker,
            goal,
            firstResult: !singleTurn && cache.length === 0,
        });
        if (!singleTurn)
            appendCache(env, sessionId, outcome.entry, config);
        logEvent(env, config, outcome);
        return outcome.stdout === null ? '' : JSON.stringify(outcome.stdout);
    }
    catch {
        return '';
    }
}
//# sourceMappingURL=adapter.js.map