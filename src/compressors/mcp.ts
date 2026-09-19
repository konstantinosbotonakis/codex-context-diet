import type { Extractor } from './types.js';
import { sampleCapsule } from './generic.js';

/** MCP output has no standard shape, so a bounded sample is the honest answer. */
export const mcpOutput: Extractor = (input, budgets) => {
  if (!input.toolName.startsWith('mcp__')) return null;
  return sampleCapsule(input, budgets, 'mcp');
};

