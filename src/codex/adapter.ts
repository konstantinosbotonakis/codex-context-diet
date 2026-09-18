import { appendCache, readCache } from '../cache.js';
import { loadConfig, type DietConfig } from '../config.js';
import { resolveApiKey } from '../key.js';
import { estimateTokens } from '../state.js';
import { capturePayload } from './capture.js';
import { runDiet, type DietOutcome } from './diet.js';
import { keyWarning, problemFromError, type KeyProblem } from './keyWarning.js';
import { appendEvent } from './log.js';
import { inputLine, isSkippedTool, toolResultText } from './payload.js';
import { readGoal } from './session.js';
import { createAsker } from './transport.js';

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function isErrorResponse(toolResponse: unknown): boolean {
  if (!toolResponse || typeof toolResponse !== 'object') return false;
  const record = toolResponse as Record<string, unknown>;
  return record.is_error === true || record.isError === true;
}

function logEvent(env: NodeJS.ProcessEnv, config: DietConfig, outcome: DietOutcome): void {
  appendEvent(env, config, {
    kind: 'diet',
    tool: outcome.entry.tool_name,
    action: outcome.decision.action,
    reason: outcome.decision.reason,
    keepCall: outcome.decision.keepCall,
    needsContents: outcome.decision.needsContents,
    replaceable: outcome.decision.replaceable,
    injection: outcome.decision.injection,
    chars: outcome.entry.chars,
    blocked: outcome.blocked,
    inputTokens: outcome.inputTokens,
  });
}

/** Reads one hook payload and returns at most one stdout object. Never throws. */
export async function main(stdin: string, env: NodeJS.ProcessEnv): Promise<string> {
  try {
    capturePayload(env, stdin);
    let payload: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(stdin);
      if (!parsed || typeof parsed !== 'object') return '';
      payload = parsed as Record<string, unknown>;
    } catch {
      return '';
    }
    if (payload.hook_event_name !== 'PostToolUse') return '';

    const config = loadConfig(env);
    if (!config.enabled) return '';

    const toolName = text(payload.tool_name);
    if (isSkippedTool(toolName, config)) return '';

    const resultText = toolResultText(toolName, payload.tool_response);
    if (resultText === null) return '';
    if (estimateTokens(resultText) < config.minTokens) return '';

    const sessionId = text(payload.session_id);
    // stateSource 'off' is single-turn: no history is read and nothing is written.
    const singleTurn = config.stateSource === 'off';
    const cache = singleTurn ? [] : readCache(env, sessionId, config);
    const firstResult = !singleTurn && cache.length === 0;
    const { goal, goalIndex } = readGoal(env, sessionId);
    const { key } = resolveApiKey(config, env);
    // CONTEXT_DIET_TEST_ANSWERS is a tests-only transport: it never reaches the
    // network, so it may stand in for a missing key.
    const asker =
      key !== null || env.CONTEXT_DIET_TEST_ANSWERS
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
      firstResult,
    });

    if (!singleTurn) appendCache(env, sessionId, outcome.entry, config);
    logEvent(env, config, outcome);

    // A missing or rejected key means Jev never ran. Say so once per session
    // rather than failing silently.
    // The first result of a session is never sent to Jev, so a missing key is
    // not worth mentioning there.
    const problem: KeyProblem | null = firstResult
      ? null
      : asker === null
        ? 'missing'
        : problemFromError(outcome.decision.reason);
    if (problem !== null) {
      const warning = keyWarning(env, sessionId, problem);
      if (warning !== null) {
        appendEvent(env, config, { kind: problem === 'missing' ? 'key_missing' : 'key_rejected', problem });
        return JSON.stringify({ systemMessage: warning });
      }
    }

    return outcome.stdout === null ? '' : JSON.stringify(outcome.stdout);
  } catch {
    return '';
  }
}
