#!/usr/bin/env node
/**
 * Fit the Laya thresholds on the labelled corpus.
 *
 * Laya ships raw temperature logits, so its noul scores sit near 0.5 and the
 * thresholds tuned for Jev keep every result. This asks the local model the
 * same five questions the diet asks, then searches for the keep and drop
 * thresholds that decide the corpus best, preferring fewer false drops on a
 * tie. The result is written to the config only with --write.
 *
 *   node scripts/calibrate-laya.mjs           # report only
 *   node scripts/calibrate-laya.mjs --write   # save the fitted thresholds
 */
import { loadConfig, saveConfig } from '../dist/config.js';
import { decideDiet } from '../dist/codex/diet.js';
import { loadCases, readFixture, runEvaluation } from '../dist/eval.js';
import { redactText } from '../dist/privacy.js';
import { looksLikeFailure } from '../dist/sample.js';

const write = process.argv.includes('--write');
const env = process.env;
const config = loadConfig(env);

console.log('provider: ' + config.provider + (config.provider === 'laya' ? ' (' + config.layaModel + '/' + config.layaSubfolder + ')' : ''));
console.log('asking the corpus, this takes a minute...');
const report = await runEvaluation({ live: true, dump: true });

const fixtures = new Map(loadCases().map((item) => [item.id, item]));
const cases = report.cases.filter((item) => item.answers !== undefined);

const scored = cases.map((item) => {
  const answers = item.answers ?? {};
  const noul = (key) => (typeof answers[key]?.noul === 'number' ? answers[key].noul : 0);
  const hazard = Math.max(noul('agent_directed'), noul('behaviour_change'));
  const caseDef = fixtures.get(item.id);
  const resultText = caseDef ? readFixture(caseDef.fixture) : '';
  return {
    id: item.id,
    expected: item.expected,
    answers: {
      keepCall: noul('keep_call'),
      needsContents: noul('needs_contents'),
      replaceable: noul('replaceable'),
      injection: hazard,
    },
    failureBar: looksLikeFailure(resultText) || redactText(resultText, 'strict').findings > 0,
  };
});

const round = (value) => Math.round(value * 100) / 100;
const grid = [];
for (let keep = 0.5; keep <= 0.96; keep += 0.02) {
  for (let drop = 0.04; drop < keep; drop += 0.02) {
    const thresholds = { ...config, keepThreshold: round(keep), dropThreshold: round(drop) };
    let correct = 0;
    let falseDrops = 0;
    let falseKeeps = 0;
    for (const item of scored) {
      const decision = decideDiet(item.answers, thresholds, { failureBar: item.failureBar });
      const actual = decision.action === 'drop_result' ? 'drop' : 'keep';
      if (actual === item.expected) correct += 1;
      else if (item.expected === 'keep') falseDrops += 1;
      else falseKeeps += 1;
    }
    grid.push({ keep: round(keep), drop: round(drop), correct, falseDrops, falseKeeps });
  }
}

grid.sort((left, right) =>
  right.correct - left.correct || left.falseDrops - right.falseDrops || left.falseKeeps - right.falseKeeps,
);
const best = grid[0];
const current = grid.find((item) => item.keep === config.keepThreshold && item.drop === config.dropThreshold);

console.log('');
console.log('cases:            ' + scored.length);
console.log('current policy:   keep ' + config.keepThreshold + ' / drop ' + config.dropThreshold +
  (current ? ' -> ' + current.correct + ' correct, ' + current.falseDrops + ' false drops, ' + current.falseKeeps + ' false keeps' : ' (not on the grid)'));
console.log('best thresholds:  keep ' + best.keep + ' / drop ' + best.drop +
  ' -> ' + best.correct + ' correct, ' + best.falseDrops + ' false drops, ' + best.falseKeeps + ' false keeps');
console.log('runner-up:        keep ' + (grid[1]?.keep ?? '-') + ' / drop ' + (grid[1]?.drop ?? '-') +
  ' -> ' + (grid[1]?.correct ?? 0) + ' correct, ' + (grid[1]?.falseDrops ?? 0) + ' false drops');

if (write) {
  saveConfig(env, { keepThreshold: best.keep, dropThreshold: best.drop });
  console.log('written to ' + 'the config file');
} else {
  console.log('run with --write to save the fitted thresholds');
}

