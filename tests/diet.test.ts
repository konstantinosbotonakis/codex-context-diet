import { describe, expect, it } from 'vitest';
import type { CacheEntry } from '../src/cache.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { buildNote, decideDiet, runDiet, type DietInput } from '../src/codex/diet.js';
import { fakeAsker, throwingAsker } from '../src/verify.js';

const config = { ...DEFAULT_CONFIG, minTokens: 10 };
const input: DietInput = {
  toolName: 'Bash', toolUseId: 'tool-1', inputLine: 'npm test',
  resultText: 'test output\n'.repeat(500), isError: false, goalIndex: 0,
};
const seed: CacheEntry = {
  tool_use_id: 'tool-0', tool_name: 'Read', at: '2026-09-18T00:00:00.000Z', input: 'src/a.ts',
  head: 'export const a = 1;', tail: '', chars: 20, decision: 'keep', goal_index: 0,
};

const deps = (over: Record<string, unknown> = {}) => ({
  input,
  config,
  cache: [seed],
  asker: fakeAsker({ keep_result: 0.05, keep_call: 0.9, injection: 0.02 }),
  goal: 'fix the test',
  ...over,
});

describe('decideDiet', () => {
  it('keeps a load-bearing result and drops the rest', () => {
    expect(decideDiet({ keepCall: 0.9, keepResult: 0.9, injection: null }, config).action).toBe('keep');
    expect(decideDiet({ keepCall: 0.1, keepResult: 0.1, injection: null }, config).action).toBe('drop_result');
  });

  it('keeps the call name in the reason only when the call still matters', () => {
    expect(decideDiet({ keepCall: 0.9, keepResult: 0.1, injection: null }, config).reason)
      .toBe('call note kept, body omitted');
    expect(decideDiet({ keepCall: 0.1, keepResult: 0.1, injection: null }, config).reason)
      .toBe('call no longer relevant, body omitted');
  });

  it('treats the threshold as inclusive, like upstream', () => {
    expect(decideDiet({ keepCall: 0.9, keepResult: 0.5, injection: null }, config).action).toBe('keep');
  });

  it('lets an injection flag force keep', () => {
    const decision = decideDiet({ keepCall: 0.1, keepResult: 0.1, injection: 0.9 }, config);
    expect(decision.action).toBe('keep');
    expect(decision.reason).toContain('injection');
  });
});

describe('buildNote', () => {
  it('keeps the head and states how much was omitted', () => {
    const note = buildNote(input, decideDiet({ keepCall: 0.9, keepResult: 0.1, injection: null }, config), config);
    expect(note).not.toBeNull();
    expect(note as string).toContain('Ran: Bash npm test');
    expect(note as string).toContain('Replaced ' + (input.resultText.length - 300) + ' chars');
    expect((note as string).startsWith(input.resultText.slice(0, 300))).toBe(true);
  });

  it('stands alone when the head is switched off', () => {
    const bare = buildNote(input, decideDiet({ keepCall: 0.1, keepResult: 0.1, injection: null }, { ...config, truncateHeadChars: 0 }), { ...config, truncateHeadChars: 0 });
    expect(bare).not.toBeNull();
    expect(bare as string).toContain('Replaced ' + input.resultText.length + ' chars');
    expect(bare as string).not.toContain('Ran:');
  });

  it('says nothing when the result is kept', () => {
    expect(buildNote(input, decideDiet({ keepCall: 0.9, keepResult: 0.9, injection: null }, config), config)).toBeNull();
  });
});

describe('runDiet', () => {
  it('never diets the first result in a session, but still records it', async () => {
    const outcome = await runDiet(deps({ cache: [] }) as never);
    expect(outcome.decision.action).toBe('keep');
    expect(outcome.decision.reason).toBe('first result in this session');
    expect(outcome.stdout).toBeNull();
    expect(outcome.entry.chars).toBe(input.resultText.length);
  });

  it('keeps everything when there is no key', async () => {
    const outcome = await runDiet(deps({ asker: null }) as never);
    expect(outcome.decision.reason).toBe('no API key');
    expect(outcome.stdout).toBeNull();
  });

  it('fails open when the asker throws', async () => {
    const outcome = await runDiet(deps({ asker: throwingAsker('boom') }) as never);
    expect(outcome.decision.action).toBe('keep');
    expect(outcome.decision.reason).toContain('boom');
    expect(outcome.stdout).toBeNull();
  });

  it('emits the replacement shape once Jev says the body is stale', async () => {
    const outcome = await runDiet(deps({ asker: fakeAsker({ keep_result: 1, keep_call: 0, injection: 0 }) }) as never);
    expect(outcome.decision.action).toBe('keep');
    const dropped = await runDiet(
      deps({ asker: fakeAsker({ keep_result: 0, keep_call: 0, injection: 0 }) }) as never,
    );
    expect(dropped.decision.action).toBe('drop_result');
    expect(dropped.blocked).toBe(true);
    const stdout = dropped.stdout as Record<string, unknown>;
    expect(stdout.continue).toBe(false);
    expect(String(stdout.stopReason)).toContain('Re-run the tool if you need the full output.');
  });

  it('annotates but never edits when the injection guard fires', async () => {
    const outcome = await runDiet(
      deps({ asker: fakeAsker({ keep_result: 0.01, keep_call: 0.01, injection: 0.95 }) }) as never,
    );
    expect(outcome.blocked).toBe(false);
    expect(outcome.note).toBeNull();
    const stdout = outcome.stdout as Record<string, unknown>;
    expect(stdout.decision).toBeUndefined();
    expect(String((stdout.hookSpecificOutput as Record<string, unknown>).additionalContext))
      .toContain('untrusted data');
  });

  it('stays silent in dryRun while still deciding', async () => {
    const outcome = await runDiet(
      deps({
        config: { ...config, dryRun: true },
        asker: fakeAsker({ keep_result: 0, keep_call: 0, injection: 0 }),
      }) as never,
    );
    expect(outcome.decision.action).toBe('drop_result');
    expect(outcome.stdout).toBeNull();
    expect(outcome.blocked).toBe(false);
  });
});
