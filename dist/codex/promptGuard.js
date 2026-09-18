import { inputTokensOf, noulAnswer } from '../request.js';
export const Q_TOUCHES_PRODUCTION = 'touches_production';
export const Q_IRREVERSIBLE = 'irreversible';
const criteria = (yes, no) => ({ true: yes, false: no });
/**
 * Two hazard questions, one literal condition each. Same rule as the diet path:
 * jev-1.13 answers the question that was written, so the boundary cases go in
 * the criteria instead of being left to interpretation.
 */
export function riskQuestions() {
    return {
        [Q_TOUCHES_PRODUCTION]: {
            type: 'noul',
            instructions: 'This request would change a live production system, live customer data, or live billing.',
            criteria: criteria('It names or implies a real deployment, a live database, real customers, or production infrastructure.', 'It is local work: reading, editing files, running tests, or exploring.'),
        },
        [Q_IRREVERSIBLE]: {
            type: 'noul',
            instructions: 'Undoing this request would need a restore, a migration, or a manual rollback rather than an edit or a re-run.',
            criteria: criteria('The change is hard to take back: deleted data, sent messages, deployed code, migrated schemas.', 'The change is easy to take back: a commit, a file edit, or a re-run.'),
        },
    };
}
export function warnLine(hazards) {
    const named = hazards.map((hazard) => hazard.id + ' ' + hazard.score.toFixed(2)).join(', ');
    return ('[codex-context-diet] This request may affect a live system (' + named + '). ' +
        'Start read-only, and confirm before changing anything live.');
}
/** Pure. A hazard at or above the threshold flags the prompt. */
export function decidePromptRisk(answers, config) {
    const hazards = [];
    for (const id of [Q_TOUCHES_PRODUCTION, Q_IRREVERSIBLE]) {
        let score = null;
        try {
            score = noulAnswer(answers, id);
        }
        catch {
            score = null;
        }
        if (score !== null && score >= config.promptGuardThreshold)
            hazards.push({ id, score });
    }
    return { hazards, line: hazards.length > 0 ? warnLine(hazards) : null };
}
/** Never throws: a failure returns a null risk and the error text, and the prompt goes through. */
export async function assessPrompt(context, asker, config) {
    if (asker === null)
        return { risk: null, error: null, inputTokens: null };
    try {
        const response = await asker.ask({ cwd: context.cwd, recent_prompts: context.recent, prompt: context.prompt }, riskQuestions());
        return { risk: decidePromptRisk(response.answers, config), error: null, inputTokens: inputTokensOf(response) };
    }
    catch (error) {
        return { risk: null, error: error instanceof Error ? error.message : String(error), inputTokens: null };
    }
}
//# sourceMappingURL=promptGuard.js.map