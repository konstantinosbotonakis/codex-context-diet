import type { DietConfig } from '../config.js';
import { inputTokensOf, noulAnswer } from '../request.js';
import { redactValue } from '../privacy.js';
import type { JevAnswer, JevAsker, JevQuestions } from '../types.js';

export const Q_TOUCHES_PRODUCTION = 'touches_production';
export const Q_IRREVERSIBLE = 'irreversible';

export interface PromptHazard {
  id: string;
  score: number;
}

export interface PromptRisk {
  hazards: PromptHazard[];
  line: string | null;
}

export interface PromptContext {
  cwd: string;
  recent: string[];
  prompt: string;
}

const criteria = (yes: string, no: string) => ({ true: yes, false: no });

/**
 * Two hazard questions, one literal condition each. Same rule as the diet path:
 * jev-1.13 answers the question that was written, so the boundary cases go in
 * the criteria instead of being left to interpretation.
 */
export function riskQuestions(): JevQuestions {
  return {
    [Q_TOUCHES_PRODUCTION]: {
      type: 'noul',
      instructions: 'This request would change a live production system, live customer data, or live billing.',
      criteria: criteria(
        'It names or implies a real deployment, a live database, real customers, or production infrastructure.',
        'It is local work: reading, editing files, running tests, or exploring.',
      ),
    },
    [Q_IRREVERSIBLE]: {
      type: 'noul',
      instructions:
        'Undoing this request would need a restore, a migration, or a manual rollback rather than an edit or a re-run.',
      criteria: criteria(
        'The change is hard to take back: deleted data, sent messages, deployed code, migrated schemas.',
        'The change is easy to take back: a commit, a file edit, or a re-run.',
      ),
    },
  };
}

export function warnLine(hazards: readonly PromptHazard[]): string {
  const named = hazards.map((hazard) => hazard.id + ' ' + hazard.score.toFixed(2)).join(', ');
  return (
    '[codex-context-diet] This request may affect a live system (' + named + '). ' +
    'Start read-only, and confirm before changing anything live.'
  );
}

/** Pure. A hazard at or above the threshold flags the prompt. */
export function decidePromptRisk(answers: Record<string, JevAnswer>, config: DietConfig): PromptRisk {
  const hazards: PromptHazard[] = [];
  for (const id of [Q_TOUCHES_PRODUCTION, Q_IRREVERSIBLE]) {
    let score: number | null = null;
    try {
      score = noulAnswer(answers, id);
    } catch {
      score = null;
    }
    if (score !== null && score >= config.promptGuardThreshold) hazards.push({ id, score });
  }
  return { hazards, line: hazards.length > 0 ? warnLine(hazards) : null };
}

export interface PromptAssessment {
  risk: PromptRisk | null;
  /** The transport error, when there was one. The caller decides whether to mention it. */
  error: string | null;
  /** Input tokens the API billed for this call, when it reported usage. */
  inputTokens: number | null;
}

/** Never throws: a failure returns a null risk and the error text, and the prompt goes through. */
export async function assessPrompt(
  context: PromptContext,
  asker: JevAsker | null,
  config: DietConfig,
): Promise<PromptAssessment> {
  if (asker === null) return { risk: null, error: null, inputTokens: null };
  try {
    const response = await asker.ask(
      redactValue(
        { cwd: context.cwd, recent_prompts: context.recent, prompt: context.prompt },
        config.privacyMode,
      ) as Record<string, unknown>,
      riskQuestions(),
    );
    return { risk: decidePromptRisk(response.answers, config), error: null, inputTokens: inputTokensOf(response) };
  } catch (error) {
    return { risk: null, error: error instanceof Error ? error.message : String(error), inputTokens: null };
  }
}
