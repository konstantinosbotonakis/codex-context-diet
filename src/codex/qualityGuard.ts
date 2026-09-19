import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, pluginDataDir, type DietConfig } from '../config.js';
import { resolveApiKey } from '../key.js';
import { redactText } from '../privacy.js';
import { inputTokensOf, noulAnswer } from '../request.js';
import type { JevQuestions } from '../types.js';
import { appendEvent } from './log.js';
import { createAsker } from './transport.js';

/**
 * Optional completion-quality guard for the Stop event.
 *
 * Off by default until the evaluation corpus shows it behaves. When on, four
 * independent Jev questions run over the last assistant message, deterministic
 * policy decides, and at most `qualityGuardMaxInterventions` continuations are
 * requested per turn. `stop_hook_active` and the per-turn ledger make a loop
 * impossible, and any failure lets the turn finish.
 */
export const QUALITY_CONTEXT =
  'An agent is about to finish its turn. Each question judges one property of the final message and, ' +
  'where relevant, of the work it describes: whether the request is satisfied, whether verification ' +
  'actually happened, whether a known failure is still unresolved, and whether a claim is unsupported.';

export const Q_REQUEST_SATISFIED = 'request_satisfied';
export const Q_VERIFICATION_COMPLETE = 'verification_complete';
export const Q_KNOWN_FAILURE = 'known_failure_remaining';
export const Q_UNSUPPORTED_CLAIM = 'unsupported_claim_present';

const MIN_MESSAGE_CHARS = 400;
const MAX_STATE_CHARS = 12_000;
const MAX_TURNS = 100;

export function qualityQuestions(): JevQuestions {
  return {
    [Q_REQUEST_SATISFIED]: {
      type: 'noul',
      instructions: 'Does the final message show that the request was carried out?',
      criteria: {
        true: 'The requested work is done, or plainly reported as impossible with a reason',
        false: 'Part of the request is unaddressed without explanation',
      },
    },
    [Q_VERIFICATION_COMPLETE]: {
      type: 'noul',
      instructions: 'Was the result verified, for example by running the relevant tests or commands?',
      criteria: {
        true: 'A test, build or command ran and its outcome is reported',
        false: 'Nothing was run, or the outcome is unknown',
      },
    },
    [Q_KNOWN_FAILURE]: {
      type: 'noul',
      instructions: 'Is a failure still known to be unresolved in the work described?',
      criteria: {
        true: 'A test, build or command is failing and the failure stands',
        false: 'No unresolved failure is described',
      },
    },
    [Q_UNSUPPORTED_CLAIM]: {
      type: 'noul',
      instructions: 'Does the message claim something as verified or done without evidence behind it?',
      criteria: {
        true: 'Success is asserted without a command, file or result to support it',
        false: 'Claims are backed by evidence or stated with appropriate uncertainty',
      },
    },
  };
}

export interface QualityVerdict {
  action: 'allow' | 'continue';
  reason: string | null;
  scores: Record<string, number>;
}

/** Deterministic policy over the four scores, most severe first. Uncertainty allows completion. */
export function decideQualityVerdict(answers: Record<string, number>, config: DietConfig): QualityVerdict {
  const threshold = config.qualityGuardThreshold;
  const satisfied = answers[Q_REQUEST_SATISFIED] ?? 0;
  const verified = answers[Q_VERIFICATION_COMPLETE] ?? 0;
  const failure = answers[Q_KNOWN_FAILURE] ?? 0;
  const unsupported = answers[Q_UNSUPPORTED_CLAIM] ?? 0;
  if (failure >= threshold) {
    return {
      action: 'continue',
      reason: 'A known failure is still unresolved. Resolve it or report exactly what remains before completing.',
      scores: answers,
    };
  }
  if (unsupported >= threshold) {
    return {
      action: 'continue',
      reason: 'One or more claims are unsupported. Add the evidence, or state plainly that they are unverified.',
      scores: answers,
    };
  }
  if (verified < threshold) {
    return {
      action: 'continue',
      reason: 'Verification is incomplete. Run the relevant test suite before completing.',
      scores: answers,
    };
  }
  if (satisfied < threshold) {
    return {
      action: 'continue',
      reason: 'The request is not satisfied yet. Keep working, or state plainly what remains and why.',
      scores: answers,
    };
  }
  return { action: 'allow', reason: null, scores: answers };
}

interface QualityLedger {
  turns: Record<string, number>;
}

function ledgerPath(env: NodeJS.ProcessEnv): string {
  return join(pluginDataDir(env), 'state', 'quality-guard.json');
}

function readLedger(env: NodeJS.ProcessEnv): QualityLedger {
  try {
    const parsed = JSON.parse(readFileSync(ledgerPath(env), 'utf8')) as QualityLedger;
    if (parsed && typeof parsed === 'object' && parsed.turns && typeof parsed.turns === 'object') return parsed;
  } catch {
    // no ledger yet
  }
  return { turns: {} };
}

function recordIntervention(env: NodeJS.ProcessEnv, turnId: string): void {
  try {
    const ledger = readLedger(env);
    ledger.turns[turnId] = (ledger.turns[turnId] ?? 0) + 1;
    const keys = Object.keys(ledger.turns);
    if (keys.length > MAX_TURNS) delete ledger.turns[keys[0] as string];
    mkdirSync(join(pluginDataDir(env), 'state'), { recursive: true });
    writeFileSync(ledgerPath(env), JSON.stringify(ledger) + '\n');
  } catch {
    // best effort
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export async function handleStop(payload: Record<string, unknown>, env: NodeJS.ProcessEnv): Promise<string> {
  try {
    const config = loadConfig(env);
    if (!config.qualityGuard) return '';
    const turnId = text(payload.turn_id) || 'unknown';
    const message = text(payload.last_assistant_message);
    appendEvent(env, config, {
      kind: 'quality_guard',
      turn: turnId,
      chars: message.length,
      active: payload.stop_hook_active === true,
    });
    if (payload.stop_hook_active === true || message.length < MIN_MESSAGE_CHARS) return '';
    if ((readLedger(env).turns[turnId] ?? 0) >= config.qualityGuardMaxInterventions) return '';
    const { key } = resolveApiKey(config, env);
    const asker =
      key !== null || env.CONTEXT_DIET_TEST_ANSWERS
        ? createAsker(config, key ?? 'test-key', env)
        : null;
    if (asker === null) return '';
    let answers: Record<string, number>;
    let tokens: number | null = null;
    try {
      const response = await asker.ask(
        { context: QUALITY_CONTEXT, result: redactText(message, config.privacyMode).text.slice(0, MAX_STATE_CHARS) },
        qualityQuestions(),
      );
      tokens = inputTokensOf(response);
      answers = {
        [Q_REQUEST_SATISFIED]: noulAnswer(response.answers, Q_REQUEST_SATISFIED),
        [Q_VERIFICATION_COMPLETE]: noulAnswer(response.answers, Q_VERIFICATION_COMPLETE),
        [Q_KNOWN_FAILURE]: noulAnswer(response.answers, Q_KNOWN_FAILURE),
        [Q_UNSUPPORTED_CLAIM]: noulAnswer(response.answers, Q_UNSUPPORTED_CLAIM),
      };
    } catch {
      return '';
    }
    const verdict = decideQualityVerdict(answers, config);
    appendEvent(env, config, {
      kind: 'quality_verdict',
      turn: turnId,
      action: verdict.action,
      scores: verdict.scores,
      inputTokens: tokens,
    });
    if (verdict.action === 'allow' || verdict.reason === null) return '';
    recordIntervention(env, turnId);
    return JSON.stringify({ decision: 'block', reason: verdict.reason });
  } catch {
    return '';
  }
}
