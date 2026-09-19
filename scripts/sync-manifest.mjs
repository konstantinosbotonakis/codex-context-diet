#!/usr/bin/env node
/**
 * Generate the legacy compatibility manifests from the portable source.
 *
 * The portable root plugin.json and mcp.json are the single source of truth.
 * Codex builds that predate the portable manifest still read the legacy
 * overlay, so the overlay is generated rather than hand-edited, and CI fails
 * when the two drift apart.
 *
 *   node scripts/sync-manifest.mjs          # write the mirrors
 *   node scripts/sync-manifest.mjs --check  # exit 1 when they are stale
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (file, rootDir = root) => JSON.parse(readFileSync(join(rootDir, file), 'utf8'));
const render = (value) => JSON.stringify(value, null, 2) + '\n';

/** The legacy overlay carries the OpenAI-specific fields the portable schema has no place for. */
export function legacyPlugin(portable) {
  const openai = (portable.extensions ?? {})['com.openai'] ?? {};
  if (!openai.interface) throw new Error('portable plugin.json has no extensions.com.openai.interface');
  return {
    name: portable.name,
    version: portable.version,
    description: portable.description,
    ...(portable.author ? { author: portable.author } : {}),
    ...(portable.homepage ? { homepage: portable.homepage } : {}),
    ...(portable.repository ? { repository: portable.repository } : {}),
    ...(portable.license ? { license: portable.license } : {}),
    ...(portable.keywords ? { keywords: portable.keywords } : {}),
    mcpServers: './.mcp.json',
    interface: openai.interface,
  };
}

/** The legacy MCP file keeps only the fields the older loader understood. */
export function legacyMcp(portable) {
  const servers = {};
  for (const [name, server] of Object.entries(portable.mcpServers ?? {})) {
    const legacy = {};
    for (const key of ['command', 'args', 'env', 'cwd']) {
      if (server[key] !== undefined) legacy[key] = server[key];
    }
    servers[name] = legacy;
  }
  return { mcpServers: servers };
}

export function mirrorFiles(rootDir = root) {
  const portable = read('plugin.json', rootDir);
  const mcp = read('mcp.json', rootDir);
  return [
    ['.codex-plugin/plugin.json', render(legacyPlugin(portable))],
    ['.mcp.json', render(legacyMcp(mcp))],
  ];
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  const check = process.argv.includes('--check');
  let stale = 0;
  for (const [file, content] of mirrorFiles()) {
    const current = readFileSync(join(root, file), 'utf8');
    if (current === content) continue;
    if (check) {
      stale += 1;
      console.error('stale legacy mirror: ' + file + ' (run npm run sync:manifest)');
    } else {
      writeFileSync(join(root, file), content);
      console.log('wrote ' + file);
    }
  }
  if (check) {
    if (stale > 0) process.exit(1);
    console.log('legacy mirrors are in sync');
  }
}
