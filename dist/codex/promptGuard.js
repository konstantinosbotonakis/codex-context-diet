import { inputTokensOf, noulAnswer } from '../request.js';
import { redactValue } from '../privacy.js';
export const Q_TOUCHES_PRODUCTION = 'touches_production';
export const Q_IRREVERSIBLE = 'irreversible';
export const Q_SENDS_EXTERNAL = 'sends_external_communications';
export const Q_MODIFIES_BILLING = 'modifies_billing';
export const Q_CHANGES_ACCESS = 'changes_authentication_or_access';
export const Q_DELETES_DATA = 'deletes_or_overwrites_data';
export const Q_TOUCHES_CREDENTIALS = 'touches_credentials_or_secrets';
export const HAZARD_IDS = [
    Q_TOUCHES_PRODUCTION,
    Q_IRREVERSIBLE,
    Q_SENDS_EXTERNAL,
    Q_MODIFIES_BILLING,
    Q_CHANGES_ACCESS,
    Q_DELETES_DATA,
    Q_TOUCHES_CREDENTIALS,
];
const criteria = (yes, no) => ({ true: yes, false: no });
/**
 * Seven hazard questions, one literal condition each. Same rule as the diet path:
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
        [Q_SENDS_EXTERNAL]: {
            type: 'noul',
            instructions: 'This request would send messages or data to recipients outside the workspace: email, SMS, chat, webhooks, or public posts.',
            criteria: criteria('Something is delivered to a recipient outside the workspace.', 'Nothing is sent, or the output stays local.'),
        },
        [Q_MODIFIES_BILLING]: {
            type: 'noul',
            instructions: 'This request would change billing or payment state: charges, refunds, subscriptions, invoices, or payouts.',
            criteria: criteria('Money movement or billing records are created, changed or cancelled.', 'Billing and payment state are untouched.'),
        },
        [Q_CHANGES_ACCESS]: {
            type: 'noul',
            instructions: 'This request would change who can authenticate or what they are allowed to access: keys, roles, permissions, or logins.',
            criteria: criteria('Access rules, roles, sessions or credentials for people or services change.', 'Access stays exactly as it is.'),
        },
        [Q_DELETES_DATA]: {
            type: 'noul',
            instructions: 'This request deletes or overwrites stored data rather than adding to it.',
            criteria: criteria('Rows, files, records or backups are removed or replaced.', 'Data is added, read, or left alone.'),
        },
        [Q_TOUCHES_CREDENTIALS]: {
            type: 'noul',
            instructions: 'This request reads, writes, rotates or exposes credentials or secrets.',
            criteria: criteria('Keys, tokens, passwords or secret material are handled or shown.', 'No credential or secret is involved.'),
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
    for (const id of HAZARD_IDS) {
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
        const response = await asker.ask(redactValue({ cwd: context.cwd, recent_prompts: context.recent, prompt: context.prompt }, config.privacyMode), riskQuestions());
        return { risk: decidePromptRisk(response.answers, config), error: null, inputTokens: inputTokensOf(response) };
    }
    catch (error) {
        return { risk: null, error: error instanceof Error ? error.message : String(error), inputTokens: null };
    }
}
//# sourceMappingURL=promptGuard.js.map