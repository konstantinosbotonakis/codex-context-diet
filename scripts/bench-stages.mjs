#!/usr/bin/env node
/**
 * Stage benchmark: what each local step costs on one large result.
 *
 *   node scripts/bench-stages.mjs [chars] [repeats]
 *
 * Offline by design. The full-hook row uses the test asker, so it shows local
 * processing only: redaction, sampling, the fingerprint, the decision, the
 * cache write and the log write, with no network. Run `npm run build` first.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { main as adapterMain } from '../dist/codex/adapter.js';
import { fingerprint } from '../dist/dedupe.js';
import { redactText } from '../dist/privacy.js';
import { sampleResult } from '../dist/sample.js';
import { estimateTokens } from '../dist/state.js';

const chars = Number(process.argv[2] ?? 200_000);
const repeats = Number(process.argv[3] ?? 5);
const line = 'a log line with a few words and a number 42\n';
const body = line.repeat(Math.ceil(chars / line.length)).slice(0, chars);

const median = (values) => [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)];
const time = (work) => {
  const times = [];
  let result;
  for (let index = 0; index < repeats; index += 1) {
    const started = performance.now();
    result = work();
    times.push(performance.now() - started);
  }
  return { ms: median(times), result };
};

const redacted = time(() => redactText(body, 'strict'));
const sampled = time(() => sampleResult(body, { budgetChars: 3000 }));
const tokens = time(() => estimateTokens(body));
const hashed = time(() => fingerprint('Bash', 'npm test', body));

const data = mkdtempSync(join(tmpdir(), 'cd-stages-'));
writeFileSync(join(data, 'config.json'), JSON.stringify({ minTokens: 10 }));
const env = {
  ...process.env,
  PLUGIN_DATA: data,
  CONTEXT_DIET_TEST_ANSWERS: JSON.stringify({
    needs_contents: 0.05, replaceable: 0.9, keep_call: 0.9, agent_directed: 0.02, behaviour_change: 0.02,
  }),
};
const payload = (id, output) =>
  JSON.stringify({
    hook_event_name: 'PostToolUse', session_id: 'bench', tool_name: 'Bash', tool_use_id: id,
    tool_input: { command: 'npm test' }, tool_response: { output },
  });

const hookRuns = [];
for (let index = 0; index < repeats; index += 1) {
  await adapterMain(payload('seed-' + index, line.repeat(200)), env);
  const started = performance.now();
  const output = await adapterMain(payload('t' + index, body), env);
  hookRuns.push({ ms: performance.now() - started, bytes: output.length });
}
const hookMs = median(hookRuns.map((run) => run.ms));
const replacement = hookRuns[hookRuns.length - 1];

const format = (value) => value.toFixed(1).padStart(9);
console.log('Context Diet stage benchmark (local only, no network)');
console.log('result ' + body.length.toLocaleString('en-US') + ' chars, median of ' + repeats + ' runs');
console.log('');
console.log('secret scan        ' + format(redacted.ms) + ' ms   ' + redacted.result.findings + ' finding(s)');
console.log('signal sample      ' + format(sampled.ms) + ' ms   omitted ' + sampled.result.omitted.toLocaleString('en-US') + ' chars');
console.log('token estimate     ' + format(tokens.ms) + ' ms   ' + tokens.result.toLocaleString('en-US') + ' tokens');
console.log('fingerprint        ' + format(hashed.ms) + ' ms   ' + hashed.result.slice(0, 16) + '...');
console.log('full hook          ' + format(hookMs) + ' ms   replacement ' + replacement.bytes + ' bytes');
console.log('');
console.log('Memory stays bounded: every stage reads with a cap and the capsule is capped too.');

