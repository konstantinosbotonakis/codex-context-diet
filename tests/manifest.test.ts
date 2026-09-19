import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { validatePlugin } from '../scripts/validate-plugin.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const validManifest = () => ({
  name: 'sample-plugin',
  version: '1.2.3',
  description: 'A sample plugin.',
  author: { name: 'Sample Author' },
  license: 'MIT',
  interface: {
    displayName: 'Sample',
    shortDescription: 'Short description',
    longDescription: 'A longer description for the details page.',
    developerName: 'Sample Author',
    category: 'Productivity',
    capabilities: ['Read'],
    defaultPrompt: ['Do the sample thing'],
  },
});

const makeRoot = (manifest: unknown, legacy: unknown = manifest): string => {
  const root = mkdtempSync(join(tmpdir(), 'cd-manifest-'));
  mkdirSync(join(root, '.codex-plugin'), { recursive: true });
  writeFileSync(join(root, '.codex-plugin', 'plugin.json'), JSON.stringify(manifest, null, 2));
  writeFileSync(join(root, 'plugin.json'), JSON.stringify(legacy, null, 2));
  // A valid root also carries the version, the hook wiring and the corpus the
  // validator now checks, so the fixture has to represent all of it.
  const version = (manifest as { version?: string }).version ?? '0.0.0';
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'sample-plugin', version }, null, 2));
  mkdirSync(join(root, 'hooks'), { recursive: true });
  const hook = { hooks: { PostToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command: 'node "$PLUGIN_ROOT/dist/x.js"', timeout: 10 }] }] } };
  writeFileSync(join(root, 'hooks', 'hooks.json'), JSON.stringify(hook, null, 2));
  writeFileSync(join(root, 'hooks', 'hooks.command.json'), JSON.stringify(hook, null, 2));
  mkdirSync(join(root, 'evals', 'fixtures'), { recursive: true });
  writeFileSync(join(root, 'evals', 'cases.json'), JSON.stringify({ description: 'fixture', cases: [
    { id: 'one', category: 'one', goal: 'goal', tool: 'Bash', input: 'npm test', fixture: 'one.txt', expectedAction: 'keep', reason: 'reason' },
  ] }, null, 2));
  writeFileSync(join(root, 'evals', 'fixtures', 'one.txt'), 'output');
  return root;
};

const anyError = (errors: string[], needle: string): boolean => errors.some((error) => error.includes(needle));

describe('plugin manifest validation', () => {
  it('passes on this repository', () => {
    expect(validatePlugin(repoRoot)).toEqual([]);
  });

  it('passes on a minimal valid manifest', () => {
    expect(validatePlugin(makeRoot(validManifest()))).toEqual([]);
  });

  it('rejects fields the ingestion schema does not accept', () => {
    const manifest = {
      ...validManifest(),
      $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
      hooks: './hooks/hooks.json',
    };
    const errors = validatePlugin(makeRoot(manifest));
    expect(anyError(errors, '`$schema`')).toBe(true);
    expect(anyError(errors, '`hooks`')).toBe(true);
  });

  it('requires an author name and a default prompt', () => {
    const manifest = validManifest() as Record<string, unknown> & ReturnType<typeof validManifest>;
    manifest.author = {};
    delete (manifest.interface as Record<string, unknown>).defaultPrompt;
    const errors = validatePlugin(makeRoot(manifest));
    expect(anyError(errors, 'author.name')).toBe(true);
    expect(anyError(errors, 'defaultPrompt')).toBe(true);
  });

  it('requires strict semver and https urls', () => {
    const manifest = validManifest();
    manifest.version = 'v1.2';
    manifest.author = { name: 'Sample Author', url: 'http://example.com' };
    manifest.interface.websiteURL = 'http://example.com';
    const errors = validatePlugin(makeRoot(manifest));
    expect(anyError(errors, 'semver')).toBe(true);
    expect(anyError(errors, 'author.url')).toBe(true);
    expect(anyError(errors, 'websiteURL')).toBe(true);
  });

  it('rejects screenshots that are not png or do not exist', () => {
    const manifest = validManifest();
    manifest.interface.screenshots = ['./assets/shot.jpg'];
    const errors = validatePlugin(makeRoot(manifest));
    expect(anyError(errors, 'PNG')).toBe(true);
    expect(anyError(errors, 'missing file')).toBe(true);
  });

  it('accepts a screenshot that exists under assets', () => {
    const manifest = validManifest();
    manifest.interface.screenshots = ['./assets/shot.png'];
    const root = makeRoot(manifest);
    mkdirSync(join(root, 'assets'), { recursive: true });
    writeFileSync(join(root, 'assets', 'shot.png'), 'png');
    expect(validatePlugin(root)).toEqual([]);
  });

  it('rejects drift between the two manifests', () => {
    const legacy = { ...validManifest(), version: '9.9.9' };
    const errors = validatePlugin(makeRoot(validManifest(), legacy));
    expect(anyError(errors, 'identical')).toBe(true);
  });

  it('rejects leftover TODO placeholders', () => {
    const manifest = validManifest();
    manifest.description = '[TODO: describe the plugin]';
    expect(anyError(validatePlugin(makeRoot(manifest)), 'TODO')).toBe(true);
  });
});
