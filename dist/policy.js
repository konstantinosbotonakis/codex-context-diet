import { extractEvidence } from './compressors/index.js';
const TEST = /\b(?:npm\s+(?:run\s+)?test|yarn\s+test|pnpm\s+test|vitest|jest|pytest|go\s+test|cargo\s+test|rspec|phpunit|mocha)\b/i;
const BUILD = /\b(?:npm\s+run\s+build|tsc\b|make\b|cargo\s+build|go\s+build|webpack|vite\s+build|next\s+build)\b/i;
const INSTALL = /\b(?:npm\s+(?:i|install|ci)\b|yarn\s+add|pnpm\s+add|pip3?\s+install|brew\s+install|cargo\s+install|go\s+get)\b/i;
const GIT = /^\s*git\b/i;
export function commandCategory(inputLine) {
    if (TEST.test(inputLine))
        return 'test';
    if (BUILD.test(inputLine))
        return 'build';
    if (GIT.test(inputLine))
        return 'git';
    if (INSTALL.test(inputLine))
        return 'install';
    return 'other';
}
export function toolFamily(toolName) {
    if (/^(?:bash|shell|exec_command|terminal)$/i.test(toolName))
        return 'bash';
    if (/^(?:read|read_file|readfile|view|view_file)$/i.test(toolName))
        return 'read';
    if (toolName.startsWith('mcp__'))
        return 'mcp';
    return 'other';
}
export function policyMatches(policy, context) {
    const match = policy.match.trim();
    if (match === '*' || match.length === 0)
        return true;
    if (match.startsWith('family:'))
        return toolFamily(context.toolName) === match.slice(7).toLowerCase();
    if (match.startsWith('output:'))
        return context.outputClass === match.slice(7).toLowerCase();
    if (match.includes(':')) {
        const separator = match.indexOf(':');
        const tool = match.slice(0, separator);
        const category = match.slice(separator + 1).toLowerCase();
        if (tool.toLowerCase() !== context.toolName.toLowerCase())
            return false;
        return commandCategory(context.inputLine) === category;
    }
    return match.toLowerCase() === context.toolName.toLowerCase();
}
export function resolveEffectivePolicy(config, context) {
    const stageFloor = {
        low: config.pressureLowTokens,
        moderate: config.pressureModerateTokens,
        high: config.pressureHighTokens,
        critical: config.pressureCriticalTokens,
    }[context.pressure];
    const floor = config.contextPressure && stageFloor > 0 ? Math.min(config.minTokens, stageFloor) : config.minTokens;
    // The last matching entry wins as a whole: an override the winner does not
    // define falls back to the base value, never to another policy's value.
    let winner = null;
    for (const policy of config.toolPolicies) {
        if (!policyMatches(policy, context))
            continue;
        winner = policy;
    }
    return {
        minTokens: winner?.minTokens ?? floor,
        keepThreshold: winner?.keepThreshold ?? config.keepThreshold,
        dropThreshold: winner?.dropThreshold ?? config.dropThreshold,
        pressure: context.pressure,
        source: winner?.match ?? 'base',
    };
}
/** Output class from a bounded sample, so the classifier cannot scan a whole file. */
export function outputClassOf(resultText, maxChars) {
    if (resultText.length <= maxChars) {
        return extractEvidence({ toolName: '', inputLine: '', resultText, isError: false }, { maxChars: 1200, maxErrorLines: 20, maxStackFrames: 10, maxSummaryLines: 8, headChars: 300 }).kind;
    }
    const half = Math.floor(maxChars / 2);
    const sample = resultText.slice(0, half) + '\n' + resultText.slice(-half);
    return extractEvidence({ toolName: '', inputLine: '', resultText: sample, isError: false }, { maxChars: 1200, maxErrorLines: 20, maxStackFrames: 10, maxSummaryLines: 8, headChars: 300 }).kind;
}
//# sourceMappingURL=policy.js.map