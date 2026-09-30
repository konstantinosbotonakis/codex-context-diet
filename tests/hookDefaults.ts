import { DEFAULT_CONFIG } from '../src/config.js';
import { hookTestConfig, SHELL_DIET_ENABLED_FOR_TESTS } from './hookDefaults.js';

/** Bash-heavy hook fixtures predate shell-off-by-default; opt back in for integration tests. */
export const SHELL_DIET_ENABLED_FOR_TESTS = {
  dietShellTools: true,
  dietAgentDirectedShell: true,
} as const;

export function hookTestConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...DEFAULT_CONFIG, ...SHELL_DIET_ENABLED_FOR_TESTS, ...overrides };
}
