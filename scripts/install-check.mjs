#!/usr/bin/env node
/**
 * Clean-install validation against a real Codex build.
 *
 * Copies the plugin into a temporary marketplace, installs it into a
 * throwaway CODEX_HOME, and asserts that the plugin, MCP server, and lifecycle
 * hooks are registered. The user's own Codex home is never touched, and
 * the cache under test is always fresh, so a globally cached copy cannot make
 * this pass.
 *
 *   node scripts/install-check.mjs
 *   CODEX_BIN=/path/to/codex node scripts/install-check.mjs
 *
 * Not part of CI: GitHub runners have no Codex desktop build. Run it locally
 * before a release.
 */
import { execFileSync, spawn } from 'node:child_process';
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
const listHooks = () => new Promise((resolve, reject) => {
  const server = spawn(codex, ['app-server', '--stdio'], { env, cwd: marketplace, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  let finished = false;
  const finish = (error, result) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    server.kill();
    if (error) reject(error);
    else resolve(result);
  };
  const timer = setTimeout(() => finish(new Error('hooks/list timed out: ' + stderr.slice(-500))), 15000);
  const send = (message) => server.stdin.write(JSON.stringify(message) + '\n');
  server.on('error', (error) => finish(error));
  server.on('close', (code) => finish(new Error('app-server exited ' + code + ': ' + stderr.slice(-500))));
  server.stdin.on('error', (error) => finish(error));
  server.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-1000); });
  server.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
    let newline;
    while ((newline = stdout.indexOf('\n')) >= 0) {
      const line = stdout.slice(0, newline);
      stdout = stdout.slice(newline + 1);
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.id === 1) {
        if (message.error) return finish(new Error(JSON.stringify(message.error)));
        send({ jsonrpc: '2.0', method: 'initialized' });
        send({ jsonrpc: '2.0', id: 2, method: 'hooks/list', params: { cwds: [marketplace] } });
      } else if (message.id === 2) {
        if (message.error) return finish(new Error(JSON.stringify(message.error)));
        finish(null, message.result?.data?.[0]);
      }
    }
  });
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
    clientInfo: { name: 'context-diet-install-check', version: '1.0.0' },
    capabilities: {},
  } });
});

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
for (const relative of ['plugin.portable.json', 'plugin.json', 'mcp.json', '.codex-plugin/plugin.json', '.mcp.json', 'hooks/hooks.json', 'hooks/hooks.mcp.json', 'skills/context-diet/SKILL.md']) {
  check('installed copy carries ' + relative, existsSync(join(installedRoot, relative)));
}

const portable = JSON.parse(readFileSync(join(installedRoot, 'plugin.portable.json'), 'utf8'));
const codexManifest = JSON.parse(readFileSync(join(installedRoot, 'plugin.json'), 'utf8'));
const legacyManifest = JSON.parse(readFileSync(join(installedRoot, '.codex-plugin', 'plugin.json'), 'utf8'));
check('Codex root manifest mirrors the legacy overlay', JSON.stringify(codexManifest) === JSON.stringify(legacyManifest));
const hookReference = portable.extensions?.['com.openai']?.hooks;
check('portable source selects the default Codex hook file', hookReference === './hooks/hooks.json', hookReference ?? 'missing');
const selectedHooksPath = hookReference === './hooks/hooks.json' ? join(installedRoot, 'hooks', 'hooks.json') : null;
const selectedHooks = selectedHooksPath && existsSync(selectedHooksPath)
  ? JSON.parse(readFileSync(selectedHooksPath, 'utf8'))
  : null;
const selectedHandlers = selectedHooks && typeof selectedHooks.hooks === 'object'
  ? Object.values(selectedHooks.hooks).flatMap((entries) => Array.isArray(entries)
    ? entries.flatMap((entry) => Array.isArray(entry.hooks) ? entry.hooks : [])
    : [])
  : [];
check('plugin-discovered lifecycle handlers use commands', selectedHandlers.length > 0 && selectedHandlers.every((handler) => handler.type === 'command'));

try {
  const registry = await listHooks();
  const registered = registry?.hooks?.filter((hook) => hook.pluginId === selector) ?? [];
  check('Codex registers the plugin lifecycle hooks',
    selectedHandlers.length > 0 && registered.length === selectedHandlers.length &&
    registered.every((hook) => hook.enabled) &&
    registry.errors.length === 0 && registry.warnings.length === 0,
    registered.length + '/' + selectedHandlers.length + ' handlers');
} catch (error) {
  check('Codex registers the plugin lifecycle hooks', false, String(error));
}

console.log('');
if (failures.length > 0) {
  console.error('install check failed: ' + failures.join(', '));
  process.exit(1);
}
console.log('install check passed');
