import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { JEV_REASONS, JEV_REASON_VALUES } from '../src/codex/diet.js';
import { localMidnight, readUsageInput, renderUsage, summarizeUsage, WINDOWS } from '../src/stats.js';

const NOW = new Date('2026-09-18T12:00:00Z');
const at = (daysAgo: number, hoursAgo = 0) =>
  new Date(NOW.getTime() - daysAgo * 86_400_000 - hoursAgo * 3_600_000).toISOString();

const cacheEntry = (daysAgo: number, decision: string, chars: number) => ({
  at: at(daysAgo), decision, chars, tool_name: 'Bash', head: 'SECRET-HEAD', input: 'SECRET-INPUT',
});

const usage = (over: Record<string, unknown> = {}) => ({
  sessions: [{ sessionId: 's1', entries: [cacheEntry(0, 'drop_result', 1000), cacheEntry(0, 'keep', 500)] }],
  events: [],
  now: NOW,
  ...over,
});

describe('usage windows', () => {
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
        events: [
          { at: at(0), kind: 'diet', reason: JEV_REASONS.stale },
          { at: at(0), kind: 'diet', reason: JEV_REASONS.uncertain },
          { at: at(0), kind: 'diet', reason: 'first result in this session' },
          { at: at(0), kind: 'diet', reason: 'no API key' },
          { at: at(0), kind: 'diet', reason: 'This operation was aborted' },
          { at: at(0), kind: 'prompt_guard', flagged: true },
          { at: at(0), kind: 'prompt_guard', flagged: false },
          { at: at(0), kind: 'key_missing' },
          { at: new Date(NOW.getTime() + 60_000).toISOString(), kind: 'diet', reason: JEV_REASONS.stale },
        ],
      }),
      JEV_REASON_VALUES,
    );
    expect(report.windows[0]).toMatchObject({
      jevCalls: 2, guardRuns: 2, guardFlags: 1, keyWarnings: 1,
    });
    expect(report.logLines).toBe(9);
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
});

describe('reading stores', () => {
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
