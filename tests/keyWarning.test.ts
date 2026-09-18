import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { keyWarning, keyWarningMessage, problemFromError } from '../src/codex/keyWarning.js';

const NOW = new Date('2026-09-18T12:00:00Z');
const minutesLater = (minutes: number): Date => new Date(NOW.getTime() + minutes * 60_000);
const tempEnv = (): NodeJS.ProcessEnv =>
  ({ PLUGIN_DATA: mkdtempSync(join(tmpdir(), 'cd-key-')) } as NodeJS.ProcessEnv);

describe('key warning', () => {
  it('says Jev was skipped and where the key goes', () => {
    const missing = keyWarningMessage('missing');
    expect(missing).toContain('no TypeSafe API key');
    expect(missing).toContain('kept in full');
    expect(missing).toContain('~/.typesafe_key');
    const rejected = keyWarningMessage('rejected');
    expect(rejected).toContain('rejected the API key');
    expect(rejected).toContain('kept in full');
  });

  it('maps 401 and 403 to a rejected key and names nothing else', () => {
    expect(problemFromError('Jev request failed (401): invalid api key')).toBe('rejected');
    expect(problemFromError('Jev request failed (403): forbidden')).toBe('rejected');
    expect(problemFromError('This operation was aborted')).toBeNull();
    expect(problemFromError('Jev returned malformed JSON')).toBeNull();
  });

  it('warns once per session', () => {
    const env = tempEnv();
    expect(keyWarning(env, 's1', 'missing', NOW)).toContain('no TypeSafe API key');
    expect(keyWarning(env, 's1', 'missing', minutesLater(5))).toBeNull();
  });

  it('holds the hour, then warns again', () => {
    const env = tempEnv();
    expect(keyWarning(env, 's1', 'missing', NOW)).not.toBeNull();
    expect(keyWarning(env, 's2', 'missing', minutesLater(59))).toBeNull();
    expect(keyWarning(env, 's3', 'missing', minutesLater(61))).toContain('no TypeSafe API key');
    const record = JSON.parse(readFileSync(join(env.PLUGIN_DATA as string, 'state', 'key-warning.json'), 'utf8'));
    expect(record.session_id).toBe('s3');
  });

  it('still warns when the record cannot be written', () => {
    const env = { PLUGIN_DATA: '/dev/null/nope' } as NodeJS.ProcessEnv;
    expect(keyWarning(env, 's1', 'missing', NOW)).toContain('no TypeSafe API key');
  });
});

