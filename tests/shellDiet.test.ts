import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config.js';
import { isShellLikeToolName, shouldSkipShellDiet, shouldSuppressShellAgentDirectedWarning } from '../src/shellDiet.js';

describe('shellDiet', () => {
  it('recognises shell-like tool names', () => {
    expect(isShellLikeToolName('Bash')).toBe(true);
    expect(isShellLikeToolName('exec_command')).toBe(true);
    expect(isShellLikeToolName('Read')).toBe(false);
  });

  it('skips shell diet when defaults disable it', () => {
    expect(shouldSkipShellDiet(DEFAULT_CONFIG, 'Bash')).toBe(true);
    expect(shouldSkipShellDiet({ ...DEFAULT_CONFIG, dietShellTools: true }, 'Bash')).toBe(false);
    expect(shouldSuppressShellAgentDirectedWarning(DEFAULT_CONFIG, 'Bash')).toBe(true);
    expect(shouldSuppressShellAgentDirectedWarning({ ...DEFAULT_CONFIG, dietAgentDirectedShell: true }, 'Bash')).toBe(false);
  });
});
