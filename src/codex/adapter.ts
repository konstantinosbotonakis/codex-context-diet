import { appendCache, appendTouch, readCache, readTouches } from '../cache.js';
import { appendRecovery, readRecoveries } from '../cache.js';
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
import { isNeverSendInput, redactText } from '../privacy.js';
import { DUPLICATE_REASON, findDuplicate, touchedPaths } from '../dedupe.js';
import { detectRecovery, inputKey } from '../recovery.js';
import { pressureStage, retainedTokens } from '../pressure.js';
import { outputClassOf, resolveEffectivePolicy } from '../policy.js';

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function isErrorResponse(toolResponse: unknown): boolean {
  if (!toolResponse || typeof toolResponse !== 'object') return false;
  const record = toolResponse as Record<string, unknown>;
  return record.is_error === true || record.isError === true;
}

function logEvent(
  env: NodeJS.ProcessEnv,
  config: DietConfig,
  outcome: DietOutcome,
  policy: { source: string; pressure: string; minTokens: number },
  ms: number,
): void {
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
    chunks: outcome.chunkIds.length > 0 ? outcome.chunkIds : undefined,
    policy: policy.source,
    pressure: policy.pressure,
    minTokens: policy.minTokens,
    ms: Math.round(ms),
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
    const sessionId = text(payload.session_id);
    // Writers are recorded even when their own result is never dieted, so a
    // later read cannot be called a duplicate of a file that has changed.
    const touched = touchedPaths(toolName, payload.tool_input);
    if (touched.length > 0) {
      appendTouch(env, sessionId, { at: new Date().toISOString(), tool: toolName, paths: touched });
    }
    if (isSkippedTool(toolName, config)) {
      appendEvent(env, config, { kind: 'skip', reason: 'excluded tool', tool: toolName });
      return '';
    }

    const resultText = toolResultText(toolName, payload.tool_response);
    if (resultText === null) {
      appendEvent(env, config, { kind: 'skip', reason: 'unsupported payload', tool: toolName });
      return '';
    }
    const rawInput = inputLine(toolName, payload.tool_input);

    // Paths and tools the user excluded stay on the machine: no Jev call, no
    // cache write, no replacement.
    if (isNeverSendInput(toolName, rawInput, config)) {
      appendEvent(env, config, { kind: 'privacy', action: 'never_send', tool: toolName });
      appendEvent(env, config, { kind: 'skip', reason: 'never-send path', tool: toolName });
      return '';
    }
    const resultRedaction = redactText(resultText, config.privacyMode);
    const inputRedaction = redactText(rawInput, config.privacyMode);
    const findings = resultRedaction.findings + inputRedaction.findings;
    if (findings > 0) {
      appendEvent(env, config, { kind: 'privacy', action: 'redacted', findings, tool: toolName });
    }
    const safeResultText = resultRedaction.text;
    const safeInput = inputRedaction.text;

    // stateSource 'off' is single-turn: no history is read and nothing is written.
    const singleTurn = config.stateSource === 'off';
    const cache = singleTurn ? [] : readCache(env, sessionId, config);
    const firstResult = !singleTurn && cache.length === 0;

    // Approximate pressure comes from what the session is still carrying, and
    // it can only lower the size gate. Tool policies then override the result.
    const pressure = pressureStage(retainedTokens(cache));
    const outputClass = config.toolPolicies.some((policy) => policy.match.startsWith('output:'))
      ? outputClassOf(safeResultText, 20_000)
      : '';
    const policy = resolveEffectivePolicy(config, { toolName, inputLine: safeInput, outputClass, pressure });
    if (estimateTokens(safeResultText) < policy.minTokens) {
      appendEvent(env, config, {
        kind: 'skip',
        reason: 'below size floor',
        tool: toolName,
        minTokens: policy.minTokens,
        pressure: policy.pressure,
        policy: policy.source,
      });
      return '';
    }
    const effectiveConfig = {
      ...config,
      minTokens: policy.minTokens,
      keepThreshold: policy.keepThreshold,
      dropThreshold: policy.dropThreshold,
    };
    const duplicate =
      config.dedupe &&
      !firstResult &&
      findDuplicate(toolName, safeInput, safeResultText, cache, readTouches(env, sessionId)) !== null;

    // A later call with the same tool and input, soon after a dropped result,
    // is scored as a recovery. It is an inference, not a certainty.
    const recovery = detectRecovery(
      cache,
      readRecoveries(env, sessionId).map((record) => record.inputHash),
      { toolName, inputLine: safeInput },
      Date.now(),
      config.recoveryWindowMs,
    );
    if (recovery !== null) {
      appendRecovery(env, sessionId, {
        of: recovery.entry.tool_use_id,
        inputHash: inputKey(toolName, safeInput),
        input: safeInput.slice(0, 200),
        at: new Date().toISOString(),
        tool: toolName,
        afterMs: recovery.afterMs,
        afterCalls: recovery.afterCalls,
        chars: recovery.entry.chars,
      });
      appendEvent(env, config, {
        kind: 'recovery',
        tool: toolName,
        of: recovery.entry.tool_use_id,
        reason: recovery.entry.reason ?? recovery.entry.decision,
        afterMs: recovery.afterMs,
        afterCalls: recovery.afterCalls,
      });
    }
    const { goal, goalIndex } = readGoal(env, sessionId);
    const { key } = resolveApiKey(config, env);
    // CONTEXT_DIET_TEST_ANSWERS is a tests-only transport: it never reaches the
    // network, so it may stand in for a missing key.
    const asker =
      key !== null || env.CONTEXT_DIET_TEST_ANSWERS
        ? createAsker(config, key ?? 'test-key', env)
        : null;

    const startedAt = performance.now();
    const outcome = await runDiet({
      input: {
        toolName,
        toolUseId: text(payload.tool_use_id),
        inputLine: safeInput,
        resultText: safeResultText,
        isError: isErrorResponse(payload.tool_response),
        goalIndex,
      },
      config: effectiveConfig,
      cache,
      asker,
      goal,
      firstResult,
      duplicate,
    });

    if (!singleTurn) appendCache(env, sessionId, outcome.entry, config);
    logEvent(env, config, outcome, policy, performance.now() - startedAt);

    // A missing or rejected key means Jev never ran. Say so once per session
    // rather than failing silently.
    // The first result of a session is never sent to Jev, so a missing key is
    // not worth mentioning there.
    // A deterministic duplicate never needed a key, so a missing key is not a
    // problem worth reporting on that path.
    const problem: KeyProblem | null = firstResult || outcome.decision.reason === DUPLICATE_REASON
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
