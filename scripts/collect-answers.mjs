#!/usr/bin/env node
/**
 * Collect the raw provider answers over the labelled corpus.
 *
 * The output is the dataset the calibration is fitted on: for every case, every
 * question, the raw model answer next to the label the case carries. Run it once
 * per provider or checkpoint and the files can be compared and fitted together.
 *
 *   node scripts/collect-answers.mjs /tmp/answers-laya-english.json
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadConfig } from '../dist/config.js';
import { runEvaluation } from '../dist/eval.js';

const out = process.argv[2] ?? '/tmp/context-diet-answers.json';
const config = loadConfig(process.env);
const report = await runEvaluation({ live: true, dump: true });
const cases = report.cases.filter((item) => item.answers !== undefined);
const document = {
  collectedAt: new Date().toISOString(),
  provider: config.provider,
  model: report.model,
  layaSubfolder: config.provider === 'laya' ? config.layaSubfolder : null,
  thresholds: { keep: config.keepThreshold, drop: config.dropThreshold },
  cases: cases.map((item) => ({ id: item.id, expected: item.expected, answers: item.answers })),
};
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(document, null, 2) + '\n');
console.log('wrote ' + out + ': ' + cases.length + ' cases from ' + report.model);

