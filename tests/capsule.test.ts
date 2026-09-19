import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config.js';
import { buildNote, decideDiet, type DietAnswers, type DietInput } from '../src/codex/diet.js';
import { renderCapsule } from '../src/compressors/index.js';

const budgets = {
  maxChars: DEFAULT_CONFIG.capsuleMaxChars,
  maxErrorLines: DEFAULT_CONFIG.capsuleMaxErrorLines,
  maxStackFrames: DEFAULT_CONFIG.capsuleMaxStackFrames,
  maxSummaryLines: DEFAULT_CONFIG.capsuleMaxSummaryLines,
  headChars: DEFAULT_CONFIG.truncateHeadChars,
};

const capsule = (over: Partial<Parameters<typeof renderCapsule>[0]>): ReturnType<typeof renderCapsule> =>
  renderCapsule({ toolName: 'Bash', inputLine: 'npm test', resultText: '', isError: false, ...over }, budgets);

const filler = Array.from({ length: 200 }, (_, index) => 'stdout line ' + index + ' with ordinary noise ' + 'n'.repeat(30)).join('\n');

const testLogText = [
  filler,
  ' FAIL  tests/payment.test.ts > checkout',
  'AssertionError: expected 200 to be 500',
  '  at tests/payment.test.ts:182:11',
  ' Tests  482 passed | 1 failed (483)',
  'exit code 1',
].join('\n');

const answers = (over: Partial<DietAnswers> = {}): DietAnswers => ({
  keepCall: 0.9, needsContents: 0.05, replaceable: 0.9, injection: null, ...over,
});

const dietInput: DietInput = {
  toolName: 'Bash', toolUseId: 'tool-1', inputLine: 'npm test',
  resultText: testLogText, isError: true, goalIndex: 0,
};

describe('evidence capsules', () => {
  it('extracts failures and the summary from a test log', () => {
    const found = capsule({ resultText: testLogText });
    expect(found.kind).toBe('test-log');
    expect(found.text).toContain('[codex-context-diet evidence]');
    expect(found.text).toContain('Command: Bash npm test');
    expect(found.text).toContain('FAIL  tests/payment.test.ts > checkout');
    expect(found.text).toContain('AssertionError: expected 200 to be 500');
    expect(found.text).toContain('tests/payment.test.ts:182:11');
    expect(found.text).toContain('482 passed | 1 failed');
    expect(found.text).toContain('chars omitted.');
    expect(found.text.length).toBeLessThanOrEqual(budgets.maxChars);
  });

  it('extracts a stack trace', () => {
    const text = ['Traceback:', 'TypeError: cannot read properties of null', '    at run (src/app.ts:12:5)', '    at main (src/index.ts:3:1)'].join('\n');
    const found = capsule({ resultText: text, toolName: 'Bash', inputLine: 'node app.js' });
    expect(found.kind).toBe('stack-trace');
    expect(found.text).toContain('TypeError: cannot read properties of null');
    expect(found.text).toContain('at run (src/app.ts:12:5)');
  });

  it('extracts compiler diagnostics', () => {
    const text = ['src/app.ts(12,5): error TS2345: Argument of type string is not assignable.', 'src/db.ts(4,1): warning: unused import'].join('\n');
    const found = capsule({ resultText: text, inputLine: 'npm run build' });
    expect(found.kind).toBe('build-log');
    expect(found.text).toContain('error TS2345');
  });

  it('describes a JSON body by shape instead of dumping it', () => {
    const found = capsule({ resultText: JSON.stringify({ id: 1, name: 'x', items: [1, 2, 3] }) });
    expect(found.kind).toBe('json');
    expect(found.text).toContain('items: array of 3 item(s)');
    expect(found.text).toContain('JSON object');
  });

  it('summarises git output', () => {
    const found = capsule({ resultText: 'On branch main\n M src/app.ts\n?? notes.txt\n', inputLine: 'git status --short' });
    expect(found.kind).toBe('git');
    expect(found.text).toContain('On branch main');
    expect(found.text).toContain('M src/app.ts');
  });

  it('falls back to a bounded sample for unknown output', () => {
    const found = capsule({ resultText: 'ordinary line\n'.repeat(20_000) });
    expect(found.kind).toBe('generic');
    expect(found.text).toContain('[codex-context-diet evidence]');
    expect(found.text).toContain('Command: Bash npm test');
    expect(found.text).toContain('ordinary line');
    expect(found.text.length).toBeLessThanOrEqual(budgets.maxChars);
  });

  it('stays bounded when the output is nothing but failures', () => {
    const found = capsule({ resultText: 'FAIL  tests/all.test.ts > everything\n'.repeat(10_000) });
    expect(found.text.length).toBeLessThanOrEqual(budgets.maxChars);
  });
});

describe('the note that replaces a result', () => {
  it('is a capsule plus the replacement trailer', () => {
    const note = buildNote(dietInput, decideDiet(answers(), DEFAULT_CONFIG), DEFAULT_CONFIG);
    expect(note).not.toBeNull();
    expect(note as string).toContain('[codex-context-diet evidence]');
    expect(note as string).toContain('AssertionError: expected 200 to be 500');
    expect(note as string).toContain('Replaced ');
    expect(note as string).toContain('chars of Bash output (error)');
    expect(note as string).toContain('Ran: Bash npm test');
    expect(note as string).toContain('Re-run the tool if you need the full output.');
    expect((note as string).length).toBeLessThanOrEqual(DEFAULT_CONFIG.capsuleMaxChars + 300);
  });

  it('keeps the trailer honest when the head is switched off', () => {
    const off = { ...DEFAULT_CONFIG, truncateHeadChars: 0 };
    const note = buildNote(dietInput, decideDiet(answers({ keepCall: 0.1 }), off), off);
    expect(note as string).toContain('Replaced ');
    expect(note as string).not.toContain('Ran:');
  });
});

