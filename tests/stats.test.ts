import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { JEV_REASONS, JEV_REASON_VALUES } from '../src/codex/diet.js';
import { DUPLICATE_REASON } from '../src/dedupe.js';
import { main as adapterMain } from '../src/codex/adapter.js';
import { localMidnight, readUsageInput, renderUsage, summarizeUsage, WINDOWS } from '../src/stats.js';

const NOW = new Date('2026-09-18T12:00:00Z');
const at = (daysAgo: number, hoursAgo = 0) =>
  new Date(NOW.getTime() - daysAgo * 86_400_000 - hoursAgo * 3_600_000).toISOString();

const cacheEntry = (daysAgo: number, decision: string, chars: number, extra: Record<string, unknown> = {}) => ({
  at: at(daysAgo), decision, chars, tool_name: 'Bash', head: 'SECRET-HEAD', input: 'SECRET-INPUT', ...extra,
});

const usage = (over: Record<string, unknown> = {}) => ({
  sessions: [{ sessionId: 's1', entries: [cacheEntry(0, 'drop_result', 1000), cacheEntry(0, 'keep', 500)] }],
  events: [],
  now: NOW,
  ...over,
});

describe('usage windows', () => {
  it('keeps logged decisions after the rolling cache evicts them, without double counting', () => {
    const event = { at: at(0), kind: 'diet', sessionId: 's1', toolUseId: 't1', action: 'drop_result',
      blocked: true, chars: 1000, keptChars: 120, reason: JEV_REASONS.stale };
    for (const entries of [[], [cacheEntry(0, 'drop_result', 1000, { tool_use_id: 't1', keptChars: 120 })]]) {
      const report = summarizeUsage(usage({ sessions: [{ sessionId: 's1', entries }], events: [event] }), JEV_REASON_VALUES);
      expect(report.windows[0]).toMatchObject({ judged: 1, replaced: 1, charsDropped: 1000, capsuleChars: 120, sessions: 1 });
    }
  });

  it('does not count an observed but unapplied drop as savings', () => {
    const report = summarizeUsage(usage({
      sessions: [{ sessionId: 's1', entries: [cacheEntry(0, 'drop_result', 1000, { tool_use_id: 't1' })] }],
      events: [{ at: at(0), kind: 'diet', sessionId: 's1', toolUseId: 't1', action: 'drop_result', blocked: false, chars: 1000 }],
    }), JEV_REASON_VALUES);
    expect(report.windows[0]).toMatchObject({ judged: 1, keeps: 1, replaced: 0, charsDropped: 0 });
  });

  it('never bills local-provider tokens as Jev usage', () => {
    const report = summarizeUsage(usage({ events: [
      { at: at(0), kind: 'diet', provider: 'laya', model: 'laya/local', reason: JEV_REASONS.needed, inputTokens: 1000 },
      { at: at(0), kind: 'prompt_guard', provider: 'laya', asked: true, inputTokens: 500 },
    ] }), JEV_REASON_VALUES);
    expect(report.windows[0]).toMatchObject({ jevCalls: 0, jevTokens: 0, costUsd: 0, guardRuns: 1 });
  });

  it('measures diet latency independently of prompt checks', () => {
    const report = summarizeUsage(usage({ events: [
      { at: at(0), kind: 'diet', ms: 100, reason: JEV_REASONS.needed },
      { at: at(0), kind: 'prompt_guard', asked: true, ms: 3500 },
    ] }), JEV_REASON_VALUES);
    expect(report.windows[0]).toMatchObject({ dietP50: 100, dietP95: 100 });
  });

  it('starts each window at local midnight, counting today as one day', () => {
    const today = new Date(localMidnight(NOW, 0));
    expect(today.getHours()).toBe(0);
    expect(today.getMinutes()).toBe(0);
    expect(WINDOWS.map((w) => w.label)).toEqual(['today', '7 days', '30 days']);
  });

  it('buckets entries and counts sessions once', () => {
    const report = summarizeUsage(
      usage({
        sessions: [
          { sessionId: 'today', entries: [cacheEntry(0, 'drop_result', 1000), cacheEntry(0, 'keep', 500)] },
          { sessionId: 'last-week', entries: [cacheEntry(3, 'drop_result', 2000)] },
          { sessionId: 'last-month', entries: [cacheEntry(20, 'drop_result', 4000)] },
          { sessionId: 'too-old', entries: [cacheEntry(45, 'drop_result', 8000)] },
        ],
      }),
      JEV_REASON_VALUES,
    );
    const [today, week, month] = report.windows;
    expect(today).toMatchObject({ sessions: 1, judged: 2, replaced: 1, charsDropped: 1000 });
    expect(week).toMatchObject({ sessions: 2, judged: 3, replaced: 2 });
    expect(month).toMatchObject({ sessions: 3, judged: 4, replaced: 3 });
    expect(report.earliest).not.toBeNull();
  });

  it('counts only real Jev answers and the guard, and ignores future timestamps', () => {
    const report = summarizeUsage(
      usage({
        sessions: [
          {
            sessionId: 's1',
            entries: [
              cacheEntry(0, 'drop_result', 1000, { reason: JEV_REASONS.stale, keptChars: 200 }),
              cacheEntry(0, 'keep', 500),
              cacheEntry(0, 'drop_result', 100, { reason: DUPLICATE_REASON, keptChars: 90 }),
            ],
          },
        ],
        events: [
          { at: at(0), kind: 'diet', reason: JEV_REASONS.stale },
          { at: at(0), kind: 'diet', reason: JEV_REASONS.uncertain },
          { at: at(0), kind: 'diet', reason: 'first result in this session' },
          { at: at(0), kind: 'diet', reason: 'no API key' },
          { at: at(0), kind: 'diet', reason: 'This operation was aborted' },
          { at: at(0), kind: 'prompt_guard', flagged: true },
          { at: at(0), kind: 'prompt_guard', flagged: false },
          { at: at(0), kind: 'key_missing' },
          { at: at(0), kind: 'recovery', tool: 'Bash', of: 't1', afterMs: 1000, afterCalls: 3 },
          { at: new Date(NOW.getTime() + 60_000).toISOString(), kind: 'diet', reason: JEV_REASONS.stale },
        ],
      }),
      JEV_REASON_VALUES,
    );
    expect(report.windows[0]).toMatchObject({
      jevCalls: 2, guardRuns: 2, guardFlags: 1, keyWarnings: 1, deterministicDrops: 1,
      recoveryReruns: 1, recoveryCalls: 3, semanticDrops: 1, entries: 3, keeps: 1, capsuleChars: 290,
    });
    expect(report.logLines).toBe(10);
  });

  it('adds up input tokens and cost from the usage the API reported', () => {
    const report = summarizeUsage(
      usage({
        events: [
          { at: at(0), kind: 'diet', reason: JEV_REASONS.stale, inputTokens: 100_000 },
          { at: at(0), kind: 'diet', reason: JEV_REASONS.needed, inputTokens: 50_000 },
          { at: at(0), kind: 'diet', reason: JEV_REASONS.uncertain },
          { at: at(0), kind: 'prompt_guard', asked: true, flagged: false, inputTokens: 2_000 },
        ],
      }),
      JEV_REASON_VALUES,
    );
    const [today] = report.windows;
    expect(today).toMatchObject({ jevCalls: 4, jevTokens: 152_000, jevMeasured: 3 });
    expect(today?.costUsd).toBeCloseTo((152_000 * 0.042) / 1_000_000, 12);
    expect(report.pricePerMillionInputTokens).toBe(0.042);
  });

  it('takes the price it is given, so a price change needs no release', () => {
    const report = summarizeUsage(
      usage({ events: [{ at: at(0), kind: 'diet', reason: JEV_REASONS.stale, inputTokens: 1_000_000 }] }),
      JEV_REASON_VALUES,
      undefined,
      1.5,
    );
    expect(report.windows[0]?.costUsd).toBeCloseTo(1.5, 12);
    expect(report.pricePerMillionInputTokens).toBe(1.5);
  });
});

describe('usage table', () => {
  it('prints the totals and never a line of content', () => {
    const report = summarizeUsage(usage(), JEV_REASON_VALUES);
    const table = renderUsage(report, { timeZone: 'Europe/London', now: NOW, stores: ['store-a'] });
    expect(table).toContain('today');
    expect(table).toContain('7 days');
    expect(table).toContain('30 days');
    expect(table).toContain('1,000');
    expect(table).toContain('reading: store-a');
    expect(table).not.toContain('SECRET-HEAD');
    expect(table).not.toContain('SECRET-INPUT');
  });

  it('says so when the log has nothing, rather than reporting zero Jev calls', () => {
    const table = renderUsage(summarizeUsage(usage(), JEV_REASON_VALUES), { timeZone: 'UTC', now: NOW });
    expect(table).toContain('need debug: true');
    expect(table).not.toMatch(/^ {2}Jev calls /m);
  });

  it('prints tokens and cost, and calls the cost a lower bound when usage is missing', () => {
    const table = renderUsage(
      summarizeUsage(
        usage({
          events: [
            { at: at(0), kind: 'diet', reason: JEV_REASONS.stale, inputTokens: 2_000 },
            { at: at(0), kind: 'diet', reason: JEV_REASONS.uncertain },
          ],
        }),
        JEV_REASON_VALUES,
      ),
      { timeZone: 'UTC', now: NOW },
    );
    expect(table).toContain('Jev input tokens');
    expect(table).toContain('2,000');
    expect(table).toContain('0.042 USD per million input tokens');
    expect(table).toContain('Cost is a lower bound: 1 call recorded no usage.');
  });

  it('reports recovery reruns and the net useful replacements', () => {
    const table = renderUsage(
      summarizeUsage(
        usage({
          sessions: [
            { sessionId: 's1', entries: [cacheEntry(0, 'drop_result', 1000), cacheEntry(0, 'keep', 500)] },
          ],
          events: [
            { at: at(0), kind: 'diet', reason: JEV_REASONS.stale },
            { at: at(0), kind: 'recovery', tool: 'Bash', of: 't1', afterMs: 1000, afterCalls: 4 },
          ],
        }),
        JEV_REASON_VALUES,
      ),
      { timeZone: 'UTC', now: NOW },
    );
    expect(table).toContain('recovery reruns');
    expect(table).toContain('net useful replacements');
    expect(table).toContain('Recoveries were re-run 4.0 tool calls after the drop on average.');
  });

  it('counts reruns by classification', () => {
    const report = summarizeUsage(
      usage({
        events: [
          { at: at(0), kind: 'recovery', tool: 'Bash', afterCalls: 1, chars: 100, classification: 'likely_recovery' },
          { at: at(0), kind: 'recovery', tool: 'Bash', afterCalls: 1, chars: 100, classification: 'possible_rerun' },
          { at: at(0), kind: 'recovery', tool: 'Bash', afterCalls: 1, chars: 100, classification: 'invalidated_rerun' },
        ],
      }),
      JEV_REASON_VALUES,
    );
    const today = report.windows[0];
    expect(today?.recoveryReruns).toBe(3);
    expect(today?.recoveryLikely).toBe(1);
    expect(today?.recoveryPossible).toBe(1);
    expect(today?.recoveryInvalidated).toBe(1);
  });
});

describe('reading stores', () => {
  it('retains real hook totals through byte-limit cache compaction', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cd-stats-rollover-'));
    const env = { PLUGIN_DATA: root, CONTEXT_DIET_TEST_ANSWERS: JSON.stringify({
      needs_contents: 0, replaceable: 1, keep_call: 1, agent_directed: 0, behaviour_change: 0,
    }) };
    try {
      writeFileSync(join(root, 'config.json'), JSON.stringify({ debug: true, minTokens: 10, cacheMaxBytes: 4096 }));
      for (let i = 0; i < 12; i++) await adapterMain(JSON.stringify({
        hook_event_name: 'PostToolUse', session_id: 's1', tool_use_id: 't' + i, tool_name: 'Bash',
        tool_input: { command: 'npm test ' + i }, tool_response: { output: ('passed test ' + i + '\n').repeat(150) },
      }), env);
      const input = readUsageInput(env);
      expect(input.sessions[0]?.entries.length).toBeLessThan(12);
      expect(summarizeUsage(input, JEV_REASON_VALUES).windows[0]).toMatchObject({
        judged: 12, replaced: 11, loggedReplacements: 11, sessions: 1,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps event identities distinct when two stores contain the same session and tool ids', () => {
    const root = mkdtempSync(join(tmpdir(), 'cd-stats-stores-'));
    try {
      for (const name of ['codex-context-diet-a', 'codex-context-diet-b']) {
        const store = join(root, name);
        mkdirSync(join(store, 'sessions'), { recursive: true });
        mkdirSync(join(store, 'log'), { recursive: true });
        writeFileSync(join(store, 'sessions', 's1.results.jsonl'), JSON.stringify(cacheEntry(0, 'drop_result', 1000, { tool_use_id: 't1' })) + '\n');
        writeFileSync(join(store, 'log', 'events.jsonl'), JSON.stringify({
          at: at(0), kind: 'diet', sessionId: 's1', toolUseId: 't1', action: 'drop_result', blocked: true, chars: 1000,
        }) + '\n');
      }
      const input = readUsageInput({ PLUGIN_DATA: join(root, 'codex-context-diet-a') }, { all: true });
      expect(summarizeUsage({ ...input, now: NOW }, JEV_REASON_VALUES).windows[0]).toMatchObject({ judged: 2, replaced: 2, sessions: 2 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reads session caches and the event log', () => {
    const root = mkdtempSync(join(tmpdir(), 'cd-stats-'));
    mkdirSync(join(root, 'sessions'), { recursive: true });
    mkdirSync(join(root, 'log'), { recursive: true });
    writeFileSync(
      join(root, 'sessions', 'abc.results.jsonl'),
      JSON.stringify(cacheEntry(0, 'drop_result', 1000)) + '\n' + 'not json\n',
    );
    writeFileSync(join(root, 'log', 'events.jsonl'), JSON.stringify({ at: at(0), kind: 'diet', reason: JEV_REASONS.stale }) + '\n');
    const input = readUsageInput({ PLUGIN_DATA: root } as NodeJS.ProcessEnv);
    expect(input.sessions).toHaveLength(1);
    expect(input.sessions[0]?.sessionId).toBe('abc');
    expect(input.sessions[0]?.entries).toHaveLength(1);
    expect(input.events).toHaveLength(1);
    expect(input.stores).toEqual([join(root).split('/').pop()]);
  });
});
