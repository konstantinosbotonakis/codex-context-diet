#!/usr/bin/env node
/**
 * Export the exact state text the diet builds, next to the teacher verdict.
 *
 * The probe is trained on the same bytes the hooks send: buildDietState then
 * redact, then JSON.stringify. Anything else would train on one distribution and
 * run on another.
 *
 *   node scripts/export-states.mjs --states /tmp/cd-mined.json --pairs /tmp/cd-pairs/mined-english.json --out /tmp/cd-states.json
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadConfig } from '../dist/config.js';
import { buildDietState } from '../dist/dietState.js';
import { decideDiet } from '../dist/codex/diet.js';
import { redactValue } from '../dist/privacy.js';
import { loadCases, readFixture } from '../dist/eval.js';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? (args[index + 1] ?? fallback) : fallback;
};
const statesFile = flag('--states', '/tmp/cd-mined.json');
const pairsFile = flag('--pairs', '/tmp/cd-pairs/mined-english.json');
const out = flag('--out', '/tmp/cd-states.json');
const corpus = args.includes('--corpus');

const merge = flag('--merge', '');
if (merge.length > 0) {
  // One training file from several row sets, so a head sees every distribution
  // it will meet: mined session results and the labelled corpus.
  const files = merge.split(',');
  const rows = files.flatMap((file) => JSON.parse(readFileSync(file, 'utf8')).rows);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ mergedAt: new Date().toISOString(), count: rows.length, rows }, null, 2) + '\n');
  console.log('wrote ' + out + ': ' + rows.length + ' states from ' + files.length + ' file(s)');
  process.exit(0);
}

const config = loadConfig(process.env);
const mined = JSON.parse(readFileSync(statesFile, 'utf8'));
let pairs = JSON.parse(readFileSync(pairsFile, 'utf8')).pairs;
let inputs = mined.states;
if (corpus) {
  // The regression corpus is a second distribution, and the head should see it.
  const corpusPairs = JSON.parse(readFileSync(flag('--corpus-pairs', '/tmp/cd-pairs/jev.json'), 'utf8'));
  pairs = corpusPairs.cases.map((item) => ({
    id: item.id,
    jev: { answers: item.answers },
    laya: null,
  }));
  inputs = loadCases().map((item) => ({
    id: item.id,
    tool: item.tool,
    input: item.input,
    goal: item.goal,
    chars: readFixture(item.fixture).length,
    resultText: readFixture(item.fixture),
    expected: item.expectedAction,
  }));
}
const byId = new Map(pairs.map((pair) => [pair.id, pair]));

const value = (answers, question) => (typeof answers?.[question]?.noul === 'number' ? answers[question].noul : 0);
const rows = [];
for (const state of inputs) {
  const pair = byId.get(state.id);
  if (!pair?.jev) continue;
  const fitted = buildDietState(
    { goal: state.goal, history: [], toolName: state.tool, inputLine: state.input, resultText: state.resultText },
    { maxStateTokens: config.maxStateTokens, resultCapChars: config.stateResultCapChars },
  ).state;
  const redacted = redactValue(fitted, config.privacyMode);
  const teacher = decideDiet(
    {
      keepCall: value(pair.jev.answers, 'keep_call'),
      needsContents: value(pair.jev.answers, 'needs_contents'),
      replaceable: value(pair.jev.answers, 'replaceable'),
      injection: Math.max(value(pair.jev.answers, 'agent_directed'), value(pair.jev.answers, 'behaviour_change')),
    },
    config,
    { failureBar: false },
  );
  rows.push({
    id: state.id,
    tool: state.tool,
    chars: state.chars,
    teacherDrop: teacher.action === 'drop_result',
    teacherHazard: Math.max(value(pair.jev.answers, 'agent_directed'), value(pair.jev.answers, 'behaviour_change')),
    expected: state.expected ?? null,
    stateText: JSON.stringify(redacted),
  });
}

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ exportedAt: new Date().toISOString(), count: rows.length, rows }, null, 2) + '\n');
const drops = rows.filter((row) => row.teacherDrop).length;
console.log('wrote ' + out + ': ' + rows.length + ' states, ' + drops + ' teacher drops');
