#!/usr/bin/env node
/**
 * What the disk-backed session state costs per decision.
 *
 * The persistent MCP process removed the per-call Node spawn. The remaining
 * question is whether keeping cache, touches, recoveries and the goal in
 * memory would be worth the complexity. This measures the reads that an
 * in-memory layer would replace.
 *
 *   node scripts/bench-state.mjs [iterations]
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { appendCache, appendRecovery, appendTouch, readCache, readRecoveries, readTouches } from '../dist/cache.js';
import { main as adapterMain } from '../dist/codex/adapter.js';
import { readGoal } from '../dist/codex/session.js';
import { configPath } from '../dist/config.js';

const iterations = Number(process.argv[2] ?? 200);
const data = mkdtempSync(join(tmpdir(), 'cd-state-'));
const env = {
  ...process.env,
  PLUGIN_DATA: data,
  CONTEXT_DIET_TEST_ANSWERS: JSON.stringify({
    needs_contents: 0.05, replaceable: 0.9, keep_call: 0.9, agent_directed: 0.02, behaviour_change: 0.02,
  }),
};
writeFileSync(configPath(env), JSON.stringify({ minTokens: 10, debug: true }));

// A realistic session: a full cache, some touches, a couple of recoveries.
for (let index = 0; index < 40; index += 1) {
  appendCache(env, 's1', {
    tool_use_id: 't' + index,
    tool_name: 'Bash',
    at: new Date().toISOString(),
    input: 'npm test -- ' + index,
    head: 'x'.repeat(300),
    tail: 'y'.repeat(300),
    chars: 40_000,
    decision: index % 3 === 0 ? 'drop_result' : 'keep',
    reason: 'bench',
    goal_index: 0,
  });
}
for (let index = 0; index < 10; index += 1) {
  appendTouch(env, 's1', { at: new Date().toISOString(), tool: 'Write', paths: ['/repo/file' + index + '.ts'] });
}
for (const index of [1, 2]) {
  appendRecovery(env, 's1', {
    of: 't' + index, inputHash: 'hash' + index, at: new Date().toISOString(),
    tool: 'Bash', afterMs: 1000, afterCalls: 1, input: 'npm test', chars: 100,
  });
}

const median = (values) => [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)];

const readTimes = [];
let reads = 0;
for (let index = 0; index < iterations; index += 1) {
  const started = performance.now();
  readCache(env, 's1');
  readTouches(env, 's1');
  readRecoveries(env, 's1');
  readGoal(env, 's1');
  readTimes.push(performance.now() - started);
  reads += 4;
}

const line = 'bench output line with some bulk\n';
const payload = (id) =>
  JSON.stringify({
    hook_event_name: 'PostToolUse', session_id: 's1', tool_name: 'Bash', tool_use_id: id,
    tool_input: { command: 'npm test' }, tool_response: { output: line.repeat(400) },
  });
const pipelineTimes = [];
for (let index = 0; index < Math.min(iterations, 60); index += 1) {
  const started = performance.now();
  await adapterMain(payload('p' + index), env);
  pipelineTimes.push(performance.now() - started);
}

const readMs = median(readTimes);
const pipelineMs = median(pipelineTimes);
console.log('Context Diet session-state cost');
console.log('cache entries 40, touches 10, recoveries 2, one session');
console.log('');
console.log('state reads per decision   ' + reads / iterations + ' (' + readMs.toFixed(3) + ' ms median)');
console.log('full local decision        ' + pipelineMs.toFixed(2) + ' ms median');
console.log('share of local decision    ' + ((readMs / pipelineMs) * 100).toFixed(1) + '%');
console.log('');
console.log('An in-memory layer would remove the reads above, not the decision work.');

