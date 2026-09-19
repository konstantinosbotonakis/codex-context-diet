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
 * Subagent context management.
 *
 * `SubagentStart` hands the subagent a result contract. `SubagentStop` asks
 * Jev whether the result is ready for the parent, and asks the subagent for one
 * more pass only when the answer is clearly no. Every path fails open, the
 * continue signal is bounded by `stop_hook_active` and a per-agent counter, and
 * interventions are recorded separately from diet decisions.
 */
export const SUBAGENT_CONTRACT =
  'Return concise findings and evidence: the conclusion, the relevant files, the important evidence, ' +
  'what was tested and its result, and any unresolved questions. Do not include full raw logs unless ' +
  'they are required to support a conclusion.';

export const SUBAGENT_CONTEXT =
  'A subagent has finished and its latest message is about to be returned to the parent agent. ' +
  'Each question judges one property of that message: whether the parent can act on it, whether the ' +
  'evidence is present, whether it is padded with raw output, and whether the request was answered.';

export const Q_ANSWER_ACTIONABLE = 'answer_actionable';
export const Q_EVIDENCE_PRESENT = 'required_evidence_present';
export const Q_REDUNDANT_OUTPUT = 'contains_large_redundant_output';
export const Q_REQUEST_SATISFIED = 'request_satisfied';

const MIN_MESSAGE_CHARS = 400;
const MAX_STATE_CHARS = 12_000;
const MAX_AGENTS = 50;

export function subagentQuestions(): JevQuestions {
  return {
    [Q_ANSWER_ACTIONABLE]: {
      type: 'noul',
      instructions: 'Can the parent agent act on this result without running the subagent again?',
      criteria: {
        true: 'It states a conclusion the parent can use directly',
        false: 'The parent would have to redo the work to use it',
      },
    },
    [Q_EVIDENCE_PRESENT]: {
      type: 'noul',
      instructions: 'Does the result carry the evidence behind its conclusion, such as files, commands or test outcomes?',
      criteria: {
        true: 'Concrete files, commands or results support the conclusion',
        false: 'The conclusion is stated without support',
      },
    },
    [Q_REDUNDANT_OUTPUT]: {
      type: 'noul',
      instructions: 'Does the result contain a large amount of raw output that adds nothing to its conclusion?',
      criteria: {
        true: 'Most of the text is raw logs, dumps or repetition',
        false: 'The text is already condensed to what matters',
      },
    },
    [Q_REQUEST_SATISFIED]: {
      type: 'noul',
      instructions: 'Does the result answer the request the subagent was given?',
      criteria: {
        true: 'The requested question or task is answered',
        false: 'The request is unanswered, partial or off topic',
      },
    },
  };
}

export interface SubagentVerdict {
  action: 'allow' | 'revise';
  reason: string | null;
  scores: Record<string, number>;
}

/** Deterministic policy over the four scores. Uncertainty allows completion. */
export function decideSubagentVerdict(answers: Record<string, number>, config: DietConfig): SubagentVerdict {
  const threshold = config.subagentGuardThreshold;
  const actionable = answers[Q_ANSWER_ACTIONABLE] ?? 0;
  const evidence = answers[Q_EVIDENCE_PRESENT] ?? 0;
  const redundant = answers[Q_REDUNDANT_OUTPUT] ?? 0;
  const satisfied = answers[Q_REQUEST_SATISFIED] ?? 0;
  if (redundant >= threshold && actionable >= threshold) {
    return {
      action: 'revise',
      reason:
        'Condense the response to the conclusion, the relevant files, the evidence and the test ' +
        'results. Drop raw logs that do not support a conclusion.',
      scores: answers,
    };
  }
  if (satisfied < threshold || actionable < threshold || evidence < threshold) {
    return {
      action: 'revise',
      reason:
        'Finish the request and return a concise, evidence-backed result: conclusion, relevant files, ' +
        'what was tested and its outcome, and any unresolved questions.',
      scores: answers,
    };
  }
  return { action: 'allow', reason: null, scores: answers };
}

interface GuardLedger {
  agents: Record<string, number>;
}

function ledgerPath(env: NodeJS.ProcessEnv): string {
  return join(pluginDataDir(env), 'state', 'subagent-guard.json');
}

function readLedger(env: NodeJS.ProcessEnv): GuardLedger {
  try {
    const parsed = JSON.parse(readFileSync(ledgerPath(env), 'utf8')) as GuardLedger;
    if (parsed && typeof parsed === 'object' && parsed.agents && typeof parsed.agents === 'object') return parsed;
  } catch {
    // no ledger yet
  }
  return { agents: {} };
}

function recordIntervention(env: NodeJS.ProcessEnv, agentId: string): void {
  try {
    const ledger = readLedger(env);
    ledger.agents[agentId] = (ledger.agents[agentId] ?? 0) + 1;
    const keys = Object.keys(ledger.agents);
    if (keys.length > MAX_AGENTS) delete ledger.agents[keys[0] as string];
    mkdirSync(join(pluginDataDir(env), 'state'), { recursive: true });
    writeFileSync(ledgerPath(env), JSON.stringify(ledger) + '\n');
  } catch {
    // best effort: a lost count costs one extra intervention at worst
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export async function handleSubagent(payload: Record<string, unknown>, env: NodeJS.ProcessEnv): Promise<string> {
  try {
    const config = loadConfig(env);
    const event = text(payload.hook_event_name);
    const agentId = text(payload.agent_id) || 'unknown';
    const agentType = text(payload.agent_type);
    if (event === 'SubagentStart') {
      appendEvent(env, config, { kind: 'subagent_start', agent: agentId, type: agentType });
      return JSON.stringify({ hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: SUBAGENT_CONTRACT } });
    }
    if (event !== 'SubagentStop') return '';
    const message = text(payload.last_assistant_message);
    appendEvent(env, config, {
      kind: 'subagent_stop',
      agent: agentId,
      type: agentType,
      chars: message.length,
      active: payload.stop_hook_active === true,
    });
    if (!config.subagentGuard) return '';
    // Codex already continued this subagent once, or the message is too small
    // to be worth judging.
    if (payload.stop_hook_active === true || message.length < MIN_MESSAGE_CHARS) return '';
    if ((readLedger(env).agents[agentId] ?? 0) >= config.subagentGuardMaxInterventions) return '';
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
        {
          context: SUBAGENT_CONTEXT,
          agent_type: agentType,
          result: redactText(message, config.privacyMode).text.slice(0, MAX_STATE_CHARS),
        },
        subagentQuestions(),
      );
      tokens = inputTokensOf(response);
      answers = {
        [Q_ANSWER_ACTIONABLE]: noulAnswer(response.answers, Q_ANSWER_ACTIONABLE),
        [Q_EVIDENCE_PRESENT]: noulAnswer(response.answers, Q_EVIDENCE_PRESENT),
        [Q_REDUNDANT_OUTPUT]: noulAnswer(response.answers, Q_REDUNDANT_OUTPUT),
        [Q_REQUEST_SATISFIED]: noulAnswer(response.answers, Q_REQUEST_SATISFIED),
      };
    } catch {
      return '';
    }
    const verdict = decideSubagentVerdict(answers, config);
    appendEvent(env, config, {
      kind: 'subagent_verdict',
      agent: agentId,
      action: verdict.action,
      scores: verdict.scores,
      inputTokens: tokens,
    });
    if (verdict.action === 'allow' || verdict.reason === null) return '';
    recordIntervention(env, agentId);
    return JSON.stringify({ decision: 'block', reason: verdict.reason });
  } catch {
    return '';
  }
}

