import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, resolveConfig } from '../src/config.js';

describe('configuration compatibility', () => {
  it('accepts the specification aliases when the canonical name is absent', () => {
    const config = resolveConfig({
      duplicateDetection: false,
      adaptiveContextPressure: false,
      chunkMaxCount: 5,
    });
    expect(config.dedupe).toBe(false);
    expect(config.contextPressure).toBe(false);
    expect(config.chunkMaxChunks).toBe(5);
  });

  it('lets the canonical name win when both spellings are present', () => {
    const config = resolveConfig({
      dedupe: true, duplicateDetection: false,
      contextPressure: true, adaptiveContextPressure: false,
      chunkMaxChunks: 9, chunkMaxCount: 2,
    });
    expect(config.dedupe).toBe(true);
    expect(config.contextPressure).toBe(true);
    expect(config.chunkMaxChunks).toBe(9);
  });

  it('places the aliases on their safe default when they are nonsense', () => {
    const config = resolveConfig({ duplicateDetection: 'yes', adaptiveContextPressure: 1, chunkMaxCount: -4 });
    expect(config.dedupe).toBe(DEFAULT_CONFIG.dedupe);
    expect(config.contextPressure).toBe(DEFAULT_CONFIG.contextPressure);
    expect(config.chunkMaxChunks).toBe(DEFAULT_CONFIG.chunkMaxChunks);
  });

  it('ignores fields from a future version instead of failing', () => {
    const config = resolveConfig({ somethingFrom2x: { deep: true }, minTokens: 1500 });
    expect(config.minTokens).toBe(1500);
    expect(config.keepThreshold).toBe(DEFAULT_CONFIG.keepThreshold);
  });

  it('loads a 0.5-era config written against the README', () => {
    const legacy = {
      enabled: true, mode: 'diet', minTokens: 2000, keepThreshold: 0.5, dropThreshold: 0.25,
      truncateHeadChars: 300, maxStateTokens: 25000, stateResultCapChars: 4000,
      requestTimeoutMs: 5000, injectionGuard: true, promptGuard: false, debug: false,
      logRetentionDays: 30, privacyMode: 'strict', capsuleMaxChars: 1200, dedupe: true,
      chunkRelevance: true, contextPressure: true, subagentGuard: true, qualityGuard: false,
    };
    const config = resolveConfig(legacy);
    expect(config.enabled).toBe(true);
    expect(config.minTokens).toBe(2000);
    expect(config.neverSendPaths).toEqual(DEFAULT_CONFIG.neverSendPaths);
    expect(config.neverSendTools).toEqual([]);
  });

  it('keeps the features with the largest behavioural reach on their conservative setting', () => {
    const config = resolveConfig({});
    expect(config.qualityGuard).toBe(false);
    expect(config.promptGuard).toBe(false);
    expect(config.chunkMaxInclude).toBeLessThanOrEqual(3);
    expect(config.dryRun).toBe(false);
  });
});

