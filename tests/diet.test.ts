import { describe, expect, it } from 'vitest';
import type { CacheEntry } from '../src/cache.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { buildNote, decideDiet, runDiet, type DietAnswers, type DietInput } from '../src/codex/diet.js';
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

const scores = (over: Partial<DietAnswers> = {}): DietAnswers => ({
  keepCall: 0.9, needsContents: 0.05, replaceable: 0.9, injection: 0.02, ...over,
});

const deps = (over: Record<string, unknown> = {}) => ({
  input,
  config,
  cache: [seed],
  asker: fakeAsker({
    needs_contents: 0.05, replaceable: 0.9, keep_call: 0.9, agent_directed: 0.02, behaviour_change: 0.02,
  }),
  goal: 'fix the test',
  firstResult: false,
  ...over,
});

describe('decideDiet', () => {
  it('keeps contents that are still needed, drops stale reproducible ones', () => {
    expect(decideDiet(scores({ needsContents: 0.9 }), config).action).toBe('keep');
    expect(decideDiet(scores(), config).action).toBe('drop_result');
  });

  it('resolves the band between the two thresholds to keep', () => {
    const band = decideDiet(scores({ needsContents: 0.4 }), config);
    expect(band.action).toBe('keep');
    expect(band.reason).toBe('uncertain, kept');
  });

  it('only drops an output that can be produced again', () => {
    const irreplaceable = decideDiet(scores({ replaceable: 0.1 }), config);
    expect(irreplaceable.action).toBe('keep');
    expect(irreplaceable.reason).toBe('not reproducible, kept');
  });

  it('treats the keep threshold as inclusive, like upstream', () => {
    expect(decideDiet(scores({ needsContents: 0.5 }), config).action).toBe('keep');
  });

  it('never drops when the call itself still matters', () => {
    const decision = decideDiet(scores({ keepCall: 1 }), config);
    expect(decision.action).toBe('drop_result');
    const note = buildNote(input, decision, config);
    expect(note as string).toContain('Ran: Bash npm test');
  });

  it('lets a hazard verdict force keep', () => {
    const decision = decideDiet(scores({ injection: 0.9 }), config);
    expect(decision.action).toBe('keep');
    expect(decision.reason).toContain('hazard');
  });
});

describe('buildNote', () => {
  it('keeps the head and states how much was omitted', () => {
    const note = buildNote(input, decideDiet(scores(), config), config);
    expect(note).not.toBeNull();
    expect(note as string).toContain('Replaced ' + (input.resultText.length - 300) + ' chars');
    expect((note as string).startsWith(input.resultText.slice(0, 300))).toBe(true);
  });

  it('stands alone when the head is switched off', () => {
    const off = { ...config, truncateHeadChars: 0 };
    const bare = buildNote(input, decideDiet(scores({ keepCall: 0.1 }), off), off);
    expect(bare).not.toBeNull();
    expect(bare as string).toContain('Replaced ' + input.resultText.length + ' chars');
    expect(bare as string).not.toContain('Ran:');
  });

  it('says nothing when the result is kept', () => {
    expect(buildNote(input, decideDiet(scores({ needsContents: 0.9 }), config), config)).toBeNull();
  });
});

describe('runDiet', () => {
  it('never diets the first result in a session, but still records it', async () => {
    const outcome = await runDiet(deps({ cache: [], firstResult: true }) as never);
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

  it('emits the replacement shape once Jev says the body is stale and reproducible', async () => {
    const kept = await runDiet(
      deps({ asker: fakeAsker({ needs_contents: 1, replaceable: 0, keep_call: 0, agent_directed: 0, behaviour_change: 0 }) }) as never,
    );
    expect(kept.decision.action).toBe('keep');

    const dropped = await runDiet(
      deps({ asker: fakeAsker({ needs_contents: 0, replaceable: 1, keep_call: 0, agent_directed: 0, behaviour_change: 0 }) }) as never,
    );
    expect(dropped.decision.action).toBe('drop_result');
    expect(dropped.blocked).toBe(true);
    const stdout = dropped.stdout as Record<string, unknown>;
    expect(stdout.decision).toBe('block');
    expect(String(stdout.reason)).toContain('Re-run the tool if you need the full output.');
  });

  it('annotates but never edits when the hazard guard fires', async () => {
    const outcome = await runDiet(
      deps({ asker: fakeAsker({ needs_contents: 0.01, replaceable: 0.9, keep_call: 0.01, agent_directed: 0.95, behaviour_change: 0.1 }) }) as never,
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
        asker: fakeAsker({ needs_contents: 0, replaceable: 1, keep_call: 0, agent_directed: 0, behaviour_change: 0 }),
      }) as never,
    );
    expect(outcome.decision.action).toBe('drop_result');
    expect(outcome.stdout).toBeNull();
    expect(outcome.blocked).toBe(false);
  });
});
