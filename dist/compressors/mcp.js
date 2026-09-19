import { sampleCapsule } from './generic.js';
/** MCP output has no standard shape, so a bounded sample is the honest answer. */
export const mcpOutput = (input, budgets) => {
    if (!input.toolName.startsWith('mcp__'))
        return null;
    return sampleCapsule(input, budgets, 'mcp');
};
//# sourceMappingURL=mcp.js.map