#!/usr/bin/env node
/**
 * Guard evaluation over the labelled fixtures in evals/guards/.
 *
 *   node scripts/eval-guards.mjs          offline: the policy against the fixture signals
 *   node scripts/eval-guards.mjs --live   ask Jev once per case and score both guards
 *
 * Offline mode is a policy regression: it proves the decision logic turns correct
 * signals into the right action. Live mode is the semantic evaluation: it shows
 * what the model actually scores on the same cases.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../dist/config.js';
import { decideQualityVerdict, qualityQuestions } from '../dist/codex/qualityGuard.js';
import { decideSubagentVerdict, subagentQuestions } from '../dist/codex/subagent.js';
import { createAsker } from '../dist/codex/transport.js';
import { resolveApiKey } from '../dist/key.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const load = (file) => JSON.parse(readFileSync(join(root, 'evals', 'guards', file), 'utf8'));
const live = process.argv.includes('--live');
const config = loadConfig(process.env);

const suites = [
  { name: 'subagent guard', corpus: load('subagent-cases.json'), decide: decideSubagentVerdict, questions: subagentQuestions },
  { name: 'quality guard', corpus: load('quality-cases.json'), decide: decideQualityVerdict, questions: qualityQuestions },
];

let asker = null;
if (live) {
  const { key } = resolveApiKey(config, process.env);
  if (key === null) {
    console.error('no TypeSafe API key: set TYPESAFE_API_KEY or write ~/.typesafe_key');
    process.exit(1);
  }
  asker = createAsker(config, key, process.env);
}

let mismatches = 0;
let scored = 0;
for (const suite of suites) {
  const cases = suite.corpus.cases.filter((item) => !item.loopProtection);
  console.log('');
  console.log(suite.name + ' (' + (live ? 'live Jev' : 'offline policy') + '), ' + cases.length + ' cases');
  for (const item of cases) {
    let answers = item.signals ?? {};
    if (live) {
      try {
        const response = await asker.ask(item.message ?? item.id, suite.questions());
        answers = Object.fromEntries(
          Object.entries(response.answers).map(([key, value]) => [key, typeof value.noul === 'number' ? value.noul : 0]),
        );
      } catch (error) {
        console.log('  error  ' + item.id + ': ' + (error instanceof Error ? error.message : String(error)));
        mismatches += 1;
        continue;
      }
    }
    const verdict = suite.decide(answers, config);
    const ok = verdict.action === item.expected;
    scored += 1;
    if (!ok) mismatches += 1;
    console.log('  ' + (ok ? 'ok   ' : 'WRONG') + ' [' + item.id + '] expected ' + item.expected + ', got ' + verdict.action);
  }
}

console.log('');
console.log('scored ' + scored + ' cases, ' + mismatches + ' mismatch(es)');
if (!live) console.log('run with --live to ask the real model the same cases');
process.exit(mismatches > 0 && !live ? 1 : 0);

