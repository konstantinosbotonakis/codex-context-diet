#!/usr/bin/env node
/**
 * Transport benchmark: command hook versus persistent MCP server.
 *
 * Offline by design: CONTEXT_DIET_TEST_ANSWERS stands in for Jev, so the
 * numbers show local processing plus transport overhead and nothing else.
 * Jev network latency is measured separately by the live demo and the eval
 * harness, and is reported in the README.
 *
 *   node scripts/bench-hooks.mjs [iterations]
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const iterations = Number(process.argv[2] ?? 30);
const data = mkdtempSync(join(tmpdir(), 'cd-bench-'));
writeFileSync(join(data, 'config.json'), JSON.stringify({ minTokens: 100 }));
const env = {
  ...process.env,
  PLUGIN_DATA: data,
  CONTEXT_DIET_TEST_ANSWERS: JSON.stringify({
    needs_contents: 0.05, replaceable: 0.9, keep_call: 0.9, agent_directed: 0.02, behaviour_change: 0.02,
  }),
};

const resultLine = 'bench output line with some bulk\n';
const output = (iteration) => 'run ' + iteration + '\n' + resultLine.repeat(1600);
const args = (iteration) => ({
  session_id: 'bench',
  tool_name: 'Bash',
  tool_use_id: 't' + iteration,
  tool_input: { command: 'npm test -- ' + iteration },
  tool_response: { output: output(iteration) },
});

const stats = (values) => {
  const sorted = [...values].sort((left, right) => left - right);
  const pick = (fraction) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
  return {
    mean: values.reduce((sum, value) => sum + value, 0) / values.length,
    p50: pick(0.5),
    p95: pick(0.95),
  };
};

const format = (value) => value.toFixed(1).padStart(7);

const commandTimes = [];
for (let iteration = 0; iteration < iterations; iteration += 1) {
  const payload = JSON.stringify({ hook_event_name: 'PostToolUse', ...args(iteration) });
  const start = performance.now();
  execFileSync('node', [join(root, 'dist', 'codex', 'adapter-main.js')], { input: payload, env });
  commandTimes.push(performance.now() - start);
}

const child = spawn('node', [join(root, 'dist', 'mcp-server.js')], { env, stdio: ['pipe', 'pipe', 'pipe'] });
const pending = new Map();
let buffer = '';
child.stdout.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let index = buffer.indexOf('\n');
  while (index >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line.length > 0) {
      const message = JSON.parse(line);
      const resolve = pending.get(message.id);
      if (resolve) {
        pending.delete(message.id);
        resolve(message);
      }
    }
    index = buffer.indexOf('\n');
  }
});
let nextId = 0;
const call = (method, params) =>
  new Promise((resolve) => {
    nextId += 1;
    pending.set(nextId, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: nextId, method, params }) + '\n');
  });

const startupStart = performance.now();
await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'bench', version: '1' } });
const startupMs = performance.now() - startupStart;

const mcpTimes = [];
for (let iteration = 0; iteration < iterations; iteration += 1) {
  const start = performance.now();
  await call('tools/call', { name: 'post_tool_use', arguments: args(iteration) });
  mcpTimes.push(performance.now() - start);
}
child.kill();

const command = stats(commandTimes);
const mcp = stats(mcpTimes);
console.log('Context Diet transport benchmark');
console.log('iterations: ' + iterations + ', result size: ' + output(0).length + ' chars, one session, test asker');
console.log('');
console.log('                       p50      p95     mean');
console.log('command hook      ' + format(command.p50) + format(command.p95) + format(command.mean) + '   ms');
console.log('mcp tool call     ' + format(mcp.p50) + format(mcp.p95) + format(mcp.mean) + '   ms');
console.log('mcp startup       ' + format(startupMs) + '       -        -   ms (once per session)');
console.log('');
console.log('Jev network latency is excluded: the test asker stands in for it.');

