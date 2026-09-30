/** Shell/exec tools whose output is often agent-directed and should not be dieted by default. */
export function isShellLikeToolName(toolName) {
    const n = toolName.toLowerCase();
    return (n.includes('bash') ||
        n.includes('shell') ||
        n === 'exec' ||
        n.includes('exec_command') ||
        n.includes('command'));
}
export function shouldSkipShellDiet(config, toolName) {
    if (!isShellLikeToolName(toolName))
        return false;
    return config.dietShellTools === false;
}
/** When false, keep shell output but do not surface agent-directed injection warnings. */
export function shouldSuppressShellAgentDirectedWarning(config, toolName) {
    return isShellLikeToolName(toolName) && config.dietAgentDirectedShell === false;
}
//# sourceMappingURL=shellDiet.js.map