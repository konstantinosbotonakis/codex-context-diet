import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { legacyMcp, legacyPlugin } from '../scripts/sync-manifest.mjs';
import { validatePlugin } from '../scripts/validate-plugin.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const interfaceBlock = () => ({
  displayName: 'Sample',
  shortDescription: 'Short description',
  longDescription: 'A longer description for the details page.',
  developerName: 'Sample Author',
  category: 'Productivity',
  capabilities: ['Read'],
  defaultPrompt: ['Do the sample thing'],
});

const portableManifest = (over: Record<string, unknown> = {}) => ({
  $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
  name: 'sample-plugin',
  version: '1.2.3',
  description: 'A sample plugin.',
  author: { name: 'Sample Author' },
  license: 'MIT',
  extensions: { 'com.openai': { interface: interfaceBlock(), hooks: './hooks/hooks.json' } },
  ...over,
});

const portableMcp = (over: Record<string, unknown> = {}) => ({
  $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
  mcpServers: { 'sample-plugin': { type: 'stdio', command: 'sh', args: ['-c', 'echo ok'] } },
  ...over,
});

const packageFiles = ['dist', 'hooks', 'skills', 'schemas', 'evals', 'assets', 'plugin.json', 'mcp.json', '.codex-plugin', '.mcp.json', 'README.md', 'LICENSE'];

const write = (root: string, relative: string, content: unknown): void => {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n');
};

interface RootOptions {
  portable?: Record<string, unknown>;
  mcp?: Record<string, unknown>;
  legacy?: Record<string, unknown>;
  packageJson?: Record<string, unknown>;
  skipFixture?: boolean;
}

const makeRoot = (options: RootOptions = {}): string => {
  const root = mkdtempSync(join(tmpdir(), 'cd-manifest-'));
  const portable = options.portable ?? portableManifest();
  const mcp = options.mcp ?? portableMcp();
  const legacy = options.legacy ?? legacyPlugin(portable);
  write(root, 'plugin.json', portable);
  write(root, 'mcp.json', mcp);
  write(root, '.codex-plugin/plugin.json', legacy);
  write(root, '.mcp.json', legacyMcp(mcp));
  write(root, 'package.json', options.packageJson ?? { name: 'sample-plugin', version: '1.2.3', files: packageFiles });
  const hook = { hooks: { PostToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command: 'node "$PLUGIN_ROOT/dist/x.js"', timeout: 10 }] }] } };
  write(root, 'hooks/hooks.json', hook);
  write(root, 'hooks/hooks.command.json', hook);
  write(root, 'dist/cli.js', '// built');
  write(root, 'dist/mcp-server.js', '// built');
  write(root, 'skills/sample/SKILL.md', '---\nname: sample\ndescription: sample\n---\n');
  write(root, 'assets/icon.png', 'png');
  write(root, 'schemas/agent-plugins/1.0.0/plugin.schema.json', '{}');
  write(root, 'evals/cases.json', {
    description: 'fixture',
    cases: [{ id: 'one', category: 'one', goal: 'goal', tool: 'Bash', input: 'npm test', fixture: 'one.txt', expectedAction: 'keep', reason: 'reason' }],
  });
  if (!options.skipFixture) write(root, 'evals/fixtures/one.txt', 'output');
  write(root, 'examples/eval-prompts.json', { prompts: [{ prompt: 'Deploy it', expect: 'flag' }] });
  write(root, 'README.md', '# sample');
  write(root, 'LICENSE', 'MIT');
  return root;
};

const anyError = (errors: string[], needle: string): boolean => errors.some((error) => error.includes(needle));

describe('portable Agent Plugins manifest', () => {
  it('passes on this repository', () => {
    expect(validatePlugin(repoRoot)).toEqual([]);
  });

  it('passes on a complete minimal plugin root', () => {
    expect(validatePlugin(makeRoot())).toEqual([]);
  });

  it('requires the schema identifier', () => {
    const portable = portableManifest();
    delete portable.$schema;
    const errors = validatePlugin(makeRoot({ portable }));
    expect(anyError(errors, 'missing required field `$schema`')).toBe(true);
  });

  it('rejects unknown top-level fields', () => {
    const portable = portableManifest({ interface: interfaceBlock() });
    const errors = validatePlugin(makeRoot({ portable }));
    expect(anyError(errors, 'field `interface` is not accepted')).toBe(true);
  });

  it('rejects a name that breaks the portable pattern', () => {
    const errors = validatePlugin(makeRoot({ portable: portableManifest({ name: 'Sample_Plugin' }) }));
    expect(anyError(errors, 'does not match')).toBe(true);
  });

  it('rejects an mcp server without a transport type', () => {
    const mcp = portableMcp({ mcpServers: { 'sample-plugin': { command: 'sh' } } });
    const errors = validatePlugin(makeRoot({ mcp }));
    expect(anyError(errors, 'exactly one of the allowed shapes')).toBe(true);
  });

  it('rejects a reserved env name in mcp.json', () => {
    const mcp = portableMcp({
      mcpServers: { 'sample-plugin': { type: 'stdio', command: 'sh', env: { PLUGIN_ROOT: '/tmp' } } },
    });
    const errors = validatePlugin(makeRoot({ mcp }));
    expect(anyError(errors, 'PLUGIN_ROOT is a reserved name')).toBe(true);
  });

  it('rejects a hooks path that does not exist', () => {
    const portable = portableManifest();
    (portable.extensions['com.openai'] as Record<string, unknown>).hooks = './hooks/missing.json';
    const errors = validatePlugin(makeRoot({ portable }));
    expect(anyError(errors, 'points to a missing file')).toBe(true);
  });

  it('rejects an interface missing a required field', () => {
    const portable = portableManifest();
    const openai = portable.extensions['com.openai'] as { interface: Record<string, unknown> };
    delete openai.interface.longDescription;
    const errors = validatePlugin(makeRoot({ portable }));
    expect(anyError(errors, 'interface.longDescription')).toBe(true);
  });
});

describe('legacy overlay', () => {
  it('rejects $schema on the legacy manifest', () => {
    const legacy = { ...legacyPlugin(portableManifest()), $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json' };
    const errors = validatePlugin(makeRoot({ legacy }));
    expect(anyError(errors, 'field `$schema` is not accepted')).toBe(true);
  });

  it('rejects a stale legacy mirror', () => {
    const legacy = legacyPlugin(portableManifest());
    legacy.version = '9.9.9';
    const errors = validatePlugin(makeRoot({ legacy }));
    expect(anyError(errors, '.codex-plugin/plugin.json is not generated from the portable source')).toBe(true);
  });

  it('rejects version drift between carriers', () => {
    const errors = validatePlugin(makeRoot({
      packageJson: { name: 'sample-plugin', version: '0.0.1', files: packageFiles },
    }));
    expect(anyError(errors, 'versions must agree')).toBe(true);
  });
});

describe('package files and corpus', () => {
  it('rejects a files entry that does not exist', () => {
    const errors = validatePlugin(makeRoot({
      packageJson: { name: 'sample-plugin', version: '1.2.3', files: [...packageFiles, 'nope'] },
    }));
    expect(anyError(errors, 'files entry `nope` does not exist')).toBe(true);
  });

  it('rejects a files list missing a runtime directory', () => {
    const errors = validatePlugin(makeRoot({
      packageJson: { name: 'sample-plugin', version: '1.2.3', files: packageFiles.filter((entry) => entry !== 'dist') },
    }));
    expect(anyError(errors, 'files must include `dist`')).toBe(true);
  });

  it('rejects a corpus fixture that is missing', () => {
    const errors = validatePlugin(makeRoot({ skipFixture: true }));
    expect(anyError(errors, 'fixture one.txt is missing')).toBe(true);
  });
});
