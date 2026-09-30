import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config.js';
import { jevFileBoolean, jevFileChoice, jevFiles } from '../src/fileScout.js';
import { testAsker } from '../src/codex/transport.js';

const config = { ...DEFAULT_CONFIG, fileScout: true };

describe('file scout', () => {
  it('skips generated paths without Jev', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cd-scout-'));
    const pkg = join(dir, 'node_modules', 'pkg');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, 'index.js'), 'export const x = 1;\n');
    const result = await jevFileBoolean(testAsker({ relevant: 0.99 }), config, {
      path: join(pkg, 'index.js'), question: 'Is this relevant?', cwd: dir,
    });
    expect(result.action).toBe('deterministic_skip');
  });

  it('allows read in the uncertain band', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cd-scout-'));
    const srcDir = join(dir, 'src');
    mkdirSync(srcDir, { recursive: true });
    const path = join(srcDir, 'app.ts');
    writeFileSync(path, 'export function app() { return 1; }\n');
    const result = await jevFileBoolean(testAsker({ relevant: 0.4 }), config, {
      path, question: 'Is this needed?', cwd: dir,
    });
    expect(result.action).toBe('read');
    expect(result.reason).toBe('uncertain_band_allow_read');
  });

  it('skips clearly irrelevant files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cd-scout-'));
    const path = join(dir, 'noise.ts');
    writeFileSync(path, '// unrelated\n');
    const result = await jevFileBoolean(testAsker({ relevant: 0.05 }), config, {
      path, question: 'Is this about MCP file scout?', cwd: dir,
    });
    expect(result.action).toBe('skip');
  });

  it('classifies with choice', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cd-scout-'));
    const path = join(dir, 'mcp-server.ts');
    writeFileSync(path, 'export const TOOLS = ["jev_boolean"];\n');
    const result = await jevFileChoice(
      testAsker({ layer: { choice: 'entrypoint', confidence: 0.9, probabilities: { entrypoint: 0.9, domain: 0.1 } } }),
      config,
      { path, question: 'What layer is this?', options: ['entrypoint', 'domain', 'none'], cwd: dir },
    );
    expect(result.choice).toBe('entrypoint');
  });

  it('batches file questions', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cd-scout-'));
    writeFileSync(join(dir, 'a.ts'), 'jev mcp-server\n');
    writeFileSync(join(dir, 'b.ts'), 'hello\n');
    const batch = await jevFiles(testAsker({ relevant: 0.9 }), config, {
      paths: [join(dir, 'a.ts'), join(dir, 'b.ts')],
      question: 'Is this about file scout MCP?', cwd: dir,
    });
    expect(batch.jevCalls).toBe(2);
    expect(batch.results).toHaveLength(2);
  });
});
