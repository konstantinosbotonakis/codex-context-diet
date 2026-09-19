#!/usr/bin/env node
/**
 * Prompt-guard evaluation over the labelled fixture in examples/eval-prompts.json.
 *
 *   node scripts/eval-prompts.mjs          offline: print the fixture and the plan
 *   node scripts/eval-prompts.mjs --live   call Jev once per prompt and score it
 *
 * The live run needs a TypeSafe key. It prints accuracy plus the false positives
 * and false negatives, because a guard that never fires and a guard that always
 * fires both look good on a single prompt.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../dist/config.js';
import { resolveApiKey } from '../dist/key.js';
import { assessPrompt } from '../dist/codex/promptGuard.js';
import { createAsker } from '../dist/codex/transport.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = JSON.parse(readFileSync(join(root, 'examples', 'eval-prompts.json'), 'utf8'));
const prompts = fixture.prompts ?? [];
const live = process.argv.includes('--live');

if (!live) {
  console.log('Context Diet prompt-guard evaluation');
  console.log('prompts: ' + prompts.length + ' (' + prompts.filter((entry) => entry.expect === 'flag').length + ' flag, ' + prompts.filter((entry) => entry.expect === 'quiet').length + ' quiet)');
  for (const entry of prompts) console.log('  [' + entry.expect + '] ' + entry.prompt);
  console.log('');
  console.log('run with --live to call Jev once per prompt and score the result');
  process.exit(0);
}

const config = loadConfig(process.env);
const { key } = resolveApiKey(config, process.env);
if (key === null) {
  console.error('no TypeSafe API key: set TYPESAFE_API_KEY or write ~/.typesafe_key');
  process.exit(1);
}
const asker = createAsker({ ...config, requestTimeoutMs: config.promptGuardTimeoutMs }, key, process.env);

let correct = 0;
let falsePositives = 0;
let falseNegatives = 0;
let tokens = 0;
for (const entry of prompts) {
  const assessment = await assessPrompt({ cwd: process.cwd(), recent: [], prompt: entry.prompt }, asker, config);
  const flagged = assessment.risk !== null;
  const expected = entry.expect === 'flag';
  tokens += assessment.inputTokens ?? 0;
  if (flagged === expected) correct += 1;
  else if (flagged) falsePositives += 1;
  else falseNegatives += 1;
  const scores = (assessment.risk?.hazards ?? []).map((hazard) => hazard.id + ' ' + hazard.score.toFixed(2)).join(', ');
  console.log((flagged === expected ? 'ok  ' : 'miss') + ' [' + entry.expect + '] ' + entry.prompt + (scores ? '  (' + scores + ')' : '') + (assessment.error ? '  error: ' + assessment.error : ''));
}
console.log('');
console.log('accuracy: ' + correct + '/' + prompts.length + ', false positives: ' + falsePositives + ', false negatives: ' + falseNegatives + ', input tokens: ' + tokens);
process.exit(correct === prompts.length ? 0 : 1);

