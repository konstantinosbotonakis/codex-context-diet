#!/usr/bin/env node
/**
 * Clean-install validation against a real Codex build.
 *
 * Copies the plugin into a temporary marketplace, installs it into a
 * throwaway CODEX_HOME, and asserts that the plugin is enabled and that its
 * MCP server is registered. The user's own Codex home is never touched, and
 * the cache under test is always fresh, so a globally cached copy cannot make
 * this pass.
 *
 *   node scripts/install-check.mjs
 *   CODEX_BIN=/path/to/codex node scripts/install-check.mjs
 *
 * Not part of CI: GitHub runners have no Codex desktop build. Run it locally
 * before a release.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const candidates = [
  process.env.CODEX_BIN,
  '/Applications/ChatGPT.app/Contents/Resources/codex',
  'codex',
].filter((value) => typeof value === 'string' && value.length > 0);
const codex = candidates.find((candidate) => candidate === 'codex' || existsSync(candidate));

const failures = [];
const check = (label, ok, detail = '') => {
  console.log((ok ? '  ok   ' : '  FAIL ') + label + (detail ? ': ' + detail : ''));
  if (!ok) failures.push(label);
};

if (!codex) {
  console.error('no Codex binary found. Set CODEX_BIN or install the desktop app.');
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), 'cd-install-'));
const marketplace = join(work, 'marketplace');
const home = join(work, 'home');
mkdirSync(home, { recursive: true });
cpSync(root, marketplace, {
  recursive: true,
  filter: (source) => !/(\/node_modules|\/\.git)$/.test(source),
});

const env = { ...process.env, CODEX_HOME: home };
const run = (args) => execFileSync(codex, args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const marketplaceManifest = JSON.parse(readFileSync(join(marketplace, '.agents/plugins/marketplace.json'), 'utf8'));
const marketplaceName = marketplaceManifest.name;
const pluginName = marketplaceManifest.plugins[0].name;
const selector = pluginName + '@' + marketplaceName;

console.log('Context Diet clean-install check');
console.log('binary:      ' + codex);
console.log('marketplace: ' + marketplace + ' (' + marketplaceName + ')');
console.log('codex home:  ' + home);
console.log('');

run(['plugin', 'marketplace', 'add', marketplace]);
check('marketplace added', true);

const added = run(['plugin', 'add', selector]);
check('plugin installs from a fresh local marketplace', /Added plugin/.test(added), added.trim().split('\n').pop() ?? '');

const cacheRoot = join(home, 'plugins', 'cache');
check('install landed in the throwaway home', existsSync(cacheRoot), cacheRoot);

const listJson = JSON.parse(run(['plugin', 'list', '--json']));
const entry = listJson.installed.find((item) => item.pluginId === selector);
check('plugin is installed and enabled', Boolean(entry?.installed && entry?.enabled), entry ? 'version ' + entry.version : 'missing from plugin list');

const mcp = run(['mcp', 'list']);
check('MCP server registers from the plugin manifest', /context-diet/.test(mcp));

const installedRoot = join(cacheRoot, marketplaceName, pluginName, entry?.version ?? '0.0.0');
for (const relative of ['plugin.json', 'mcp.json', '.codex-plugin/plugin.json', '.mcp.json', 'hooks/hooks.json', 'skills/context-diet/SKILL.md']) {
  check('installed copy carries ' + relative, existsSync(join(installedRoot, relative)));
}

console.log('');
if (failures.length > 0) {
  console.error('install check failed: ' + failures.join(', '));
  process.exit(1);
}
console.log('install check passed');

