#!/usr/bin/env node
/**
 * Fit Laya's answers into Jev's decision space, then check the decisions on
 * held-out folds.
 *
 * One score at a time is not enough: on real states Laya's replaceable score is
 * anti-correlated with Jev's, so a per-question map recovers almost no drops. The
 * layer fitted here reads all five Laya scores jointly and predicts the three
 * scores the policy actually uses (needs_contents, replaceable, hazard) in logit
 * space, with ridge regression. The policy itself is untouched, so both providers
 * run through exactly the same decision code.
 *
 *   node scripts/fit-calibration.mjs --pairs /tmp/cd-pairs/mined-english.json
 *   node scripts/fit-calibration.mjs --pairs ... --write
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../dist/config.js';
import { decideDiet } from '../dist/codex/diet.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? (args[index + 1] ?? fallback) : fallback;
};
const pairsFile = flag('--pairs', '/tmp/cd-pairs/mined-english.json');
const write = args.includes('--write');
const source = JSON.parse(readFileSync(pairsFile, 'utf8'));
const config = loadConfig(process.env);

const clamp = (value) => Math.min(1 - 1e-4, Math.max(1e-4, value));
const logit = (value) => Math.log(clamp(value) / (1 - clamp(value)));
const sigmoid = (value) => 1 / (1 + Math.exp(-value));
const QUESTIONS = ['needs_contents', 'replaceable', 'keep_call', 'agent_directed', 'behaviour_change'];

const pairs = source.pairs.filter((pair) => pair.jev !== null && pair.laya !== null);
const noul = (answers, question) => (typeof answers?.[question]?.noul === 'number' ? answers[question].noul : null);

const features = (laya) => {
  const values = QUESTIONS.map((question) => {
    const value = noul(laya, question);
    return value === null ? 0 : logit(value);
  });
  return [1, ...values];
};

// Targets in logit space: what the policy reads from Jev.
const targets = (jev) => ({
  needsContents: logit(noul(jev, 'needs_contents') ?? 0.5),
  replaceable: logit(noul(jev, 'replaceable') ?? 0.5),
  hazard: logit(Math.max(noul(jev, 'agent_directed') ?? 0, noul(jev, 'behaviour_change') ?? 0)),
});

/** Ridge regression closed form: (X'X + lambda I) w = X'y, solved by elimination. */
function ridge(rows, labels, lambda = 1) {
  const d = rows[0].length;
  const matrix = Array.from({ length: d }, () => new Array(d + 1).fill(0));
  for (let i = 0; i < d; i += 1) {
    for (let j = 0; j < d; j += 1) {
      let sum = 0;
      for (let k = 0; k < rows.length; k += 1) sum += rows[k][i] * rows[k][j];
      matrix[i][j] = sum + (i === j ? lambda : 0);
    }
    let sum = 0;
    for (let k = 0; k < rows.length; k += 1) sum += rows[k][i] * labels[k];
    matrix[i][d] = sum;
  }
  for (let column = 0; column < d; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < d; row += 1) {
      if (Math.abs(matrix[row][column]) > Math.abs(matrix[pivot][column])) pivot = row;
    }
    [matrix[column], matrix[pivot]] = [matrix[pivot], matrix[column]];
    const lead = matrix[column][column] || 1e-9;
    for (let j = column; j <= d; j += 1) matrix[column][j] /= lead;
    for (let row = 0; row < d; row += 1) {
      if (row === column) continue;
      const factor = matrix[row][column];
      if (factor === 0) continue;
      for (let j = column; j <= d; j += 1) matrix[row][j] -= factor * matrix[column][j];
    }
  }
  return matrix.map((row) => row[d]);
}

const dot = (weights, row) => weights.reduce((sum, weight, index) => sum + weight * row[index], 0);

function fitLayer(sample) {
  const rows = sample.map((pair) => features(pair.laya));
  const targetOf = (name) => sample.map((pair) => targets(pair.jev)[name]);
  return {
    needsContents: ridge(rows, targetOf('needsContents')),
    replaceable: ridge(rows, targetOf('replaceable')),
    hazard: ridge(rows, targetOf('hazard')),
  };
}

const predictAnswers = (layer, laya) => {
  const row = features(laya);
  return {
    needs_contents: { noul: sigmoid(dot(layer.needsContents, row)) },
    replaceable: { noul: sigmoid(dot(layer.replaceable, row)) },
    keep_call: { noul: noul(laya, 'keep_call') ?? 0 },
    agent_directed: { noul: sigmoid(dot(layer.hazard, row)) },
    behaviour_change: { noul: sigmoid(dot(layer.hazard, row)) },
  };
};

const dietAnswersOf = (answers) => ({
  keepCall: noul(answers, 'keep_call') ?? 0,
  needsContents: noul(answers, 'needs_contents') ?? 0,
  replaceable: noul(answers, 'replaceable') ?? 0,
  injection: Math.max(noul(answers, 'agent_directed') ?? 0, noul(answers, 'behaviour_change') ?? 0),
});

const decide = (answers) => decideDiet(dietAnswersOf(answers), config, { failureBar: false }).action;

const folds = 5;
const order = pairs.map((pair, index) => ({ pair, key: Math.sin(index * 12.9898) })).sort((a, b) => a.key - b.key).map((entry) => entry.pair);
const buckets = Array.from({ length: folds }, () => []);
order.forEach((pair, index) => buckets[index % folds].push(pair));

let total = 0;
let teacherDrops = 0;
let rawAgree = 0;
let layerAgree = 0;
let rawRecovered = 0;
let layerRecovered = 0;
let rawFalseDrops = 0;
let layerFalseDrops = 0;

for (let fold = 0; fold < folds; fold += 1) {
  const train = buckets.filter((_, index) => index !== fold).flat();
  const test = buckets[fold];
  const layer = fitLayer(train);
  for (const pair of test) {
    const teacher = decide(pair.jev.answers);
    const raw = decide(pair.laya.answers);
    const mapped = decide(predictAnswers(layer, pair.laya.answers));
    total += 1;
    if (teacher === 'drop_result') teacherDrops += 1;
    if (raw === teacher) rawAgree += 1;
    if (mapped === teacher) layerAgree += 1;
    if (teacher === 'drop_result') {
      if (raw === 'drop_result') rawRecovered += 1;
      if (mapped === 'drop_result') layerRecovered += 1;
    } else {
      if (raw === 'drop_result') rawFalseDrops += 1;
      if (mapped === 'drop_result') layerFalseDrops += 1;
    }
  }
}

const percent = (value) => (100 * value).toFixed(1) + '%';
console.log('pairs: ' + pairs.length + ' (' + pairsFile + ')');
console.log('student: ' + source.student);
console.log('');
console.log('teacher drops:          ' + teacherDrops + ' of ' + total);
console.log('raw Laya agreement:     ' + rawAgree + '/' + total + ' (' + percent(rawAgree / total) + '), drops recovered ' + rawRecovered + ', false drops ' + rawFalseDrops);
console.log('layer agreement:        ' + layerAgree + '/' + total + ' (' + percent(layerAgree / total) + '), drops recovered ' + layerRecovered + ', false drops ' + layerFalseDrops);

if (write) {
  const layer = fitLayer(pairs);
  const document = {
    fittedAt: new Date().toISOString(),
    student: source.student,
    pairs: pairs.length,
    features: ['intercept', ...QUESTIONS.map((question) => 'logit_' + question)],
    layer,
    agreement: { total, raw: Number((rawAgree / total).toFixed(4)), mapped: Number((layerAgree / total).toFixed(4)) },
    drops: { teacher: teacherDrops, rawRecovered, layerRecovered, rawFalseDrops, layerFalseDrops },
  };
  const out = join(root, 'calibration', 'laya.json');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(document, null, 2) + '\n');
  console.log('');
  console.log('wrote ' + out);
}

