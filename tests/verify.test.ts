import { describe, expect, it } from 'vitest';
import { fakeAsker, throwingAsker, verifyCompaction } from '../src/verify.js';

describe('verification harness', () => {
  it('passes every check against a working asker', async () => {
    const report = await verifyCompaction({
      asker: fakeAsker({ keep_result: 0.1, keep_call: 0.9, injection: 0.05 }),
    });
    expect(report.ok).toBe(true);
    expect(report.checks.map((check) => check.name)).toEqual([
      'token-estimator', 'collect-tool-calls', 'fit-state', 'batch-calls',
      'asker-contract', 'decide-call', 'apply-decisions', 'reduction',
    ]);
    expect(report.stats.charsAfter).toBeLessThan(report.stats.charsBefore);
    expect(report.stats.reduction).toBeGreaterThan(0);
  });

  it('fails loudly instead of pretending when the asker is broken', async () => {
    const report = await verifyCompaction({ asker: throwingAsker('no network in verify') });
    expect(report.ok).toBe(false);
    expect(report.checks.filter((check) => !check.ok).map((check) => check.name)).toEqual([
      'asker-contract', 'decide-call',
    ]);
  });
});
