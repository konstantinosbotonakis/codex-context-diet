#!/usr/bin/env node
const repoRoot = process.cwd();
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../dist/config.js';
import { configuredAsker } from '../dist/codex/transport.js';
import { jevFileBoolean, jevFileChoice, jevFiles } from '../dist/fileScout.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env;
const config = loadConfig(env);
const asker = configuredAsker(config, env);
if (!asker) { console.error('No Jev key'); process.exit(1); }
const goal = 'Design jev_file_boolean, jev_files, and agentic jev for codex-context-diet levels 8-10';
const cwd = root;
const scenarios = [
  ['L8 mcp-server', () => jevFileBoolean(asker, config, { path: 'src/mcp-server.ts', cwd, goal, question: 'Does this file define MCP tools we must extend for jev_file_*?' })],
  ['L8 adapter', () => jevFileBoolean(asker, config, { path: 'src/codex/adapter.ts', cwd, goal, question: 'Is this the hook entry to mirror for PreToolUse file scout?' })],
  ['L8 bench skip', () => jevFileBoolean(asker, config, { path: 'src/bench.ts', cwd, goal, question: 'Is this required to implement file scout?' })],
  ['L8 choice policy', () => jevFileChoice(asker, config, { path: 'src/policy.ts', cwd, goal, question: 'What architectural layer is this file?', options: ['policy', 'entrypoint', 'docs', 'test', 'none'] })],
  ['L9 batch core', () => jevFiles(asker, config, { cwd, goal, paths: ['src/mcp-server.ts', 'src/codex/adapter.ts', 'src/codex/diet.ts', 'src/bench.ts', 'src/doctor.ts'], question: 'Is this file needed to implement jev_file_* MCP tools?', maxFiles: 10 })],
];
let calls = 0; let tokens = 0;
for (const [name, run] of scenarios) {
  const out = await run();
  calls += 'jevCalls' in out ? out.jevCalls : 1;
  tokens += out.input_tokens ?? 0;
  console.log('==', name, '==');
  console.log(JSON.stringify(out, null, 2));
}

console.log('== L9 glob src/codex/*.ts ==');
{
  const batch = await jevFiles(asker, config, {
    paths: ['src/codex/*.ts'],
    question: 'Is this file needed to implement jev_file_* MCP tools?',
    goal: 'Design jev_file_boolean, jev_files for codex-context-diet levels 8-10',
    cwd: repoRoot,
    maxFiles: 8,
  });
  console.log(JSON.stringify({ expanded: batch.results.length, useful: batch.usefulResults?.length, jevCalls: batch.jevCalls }, null, 2));
  console.log('USEFUL_GLOB', JSON.stringify(batch.usefulResults?.map((r) => r.path), null, 2));
}
console.log('TOTAL', { calls, tokens, cost_usd: Number(((tokens / 1_000_000) * config.pricePerMillionInputTokens).toFixed(6)) });
