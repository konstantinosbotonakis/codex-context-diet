#!/usr/bin/env node
/**
 * Ask both models the same questions over real mined states and keep the pairs.
 *
 * Jev is the teacher: its scores are what the policy was tuned for. Laya is the
 * student: the pairs are the dataset that maps its scores into the same space.
 * Both runs go through the production diet path, so the state, the questions and
 * the truncation are exactly what the hooks use.
 *
 *   node scripts/distill-pairs.mjs --states /tmp/cd-mined.json --out /tmp/cd-pairs/mined-pairs.json
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadConfig } from '../dist/config.js';
import { createAsker } from '../dist/codex/transport.js';
import { runDiet } from '../dist/codex/diet.js';
import { resolveApiKey } from '../dist/key.js';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? (args[index + 1] ?? fallback) : fallback;
};
const statesFile = flag('--states', '/tmp/cd-mined.json');
const out = flag('--out', '/tmp/cd-pairs/mined-pairs.json');
const limit = Number(flag('--limit', '400'));

const config = loadConfig(process.env);
const { key } = resolveApiKey(config, process.env);
if (key === null) {
  console.error('no TypeSafe key: the teacher needs one');
  process.exit(1);
}
const jevAsker = createAsker({ ...config, provider: 'jev' }, key, process.env);
const layaAsker = createAsker({ ...config, provider: 'laya' }, 'test-key', process.env);

const recording = (inner) => {
  const box = { captured: null };
  return {
    box,
    asker: {
      async ask(state, questions) {
        const response = await inner.ask(state, questions);
        box.captured = response;
        return response;
      },
    },
  };
};

const slim = (response) => {
  if (response === null) return null;
  const answers = {};
  for (const [id, answer] of Object.entries(response.answers ?? {})) {
    const record = answer;
    const item = {};
    for (const field of ['noul', 'choice', 'score', 'confidence']) {
      const value = record[field];
      if (typeof value === 'number' || typeof value === 'string') item[field] = value;
    }
    answers[id] = item;
  }
  return { answers, inputTokens: response.usage?.input_tokens ?? null };
};

const mined = JSON.parse(readFileSync(statesFile, 'utf8'));
const states = mined.states.slice(0, limit);
const pairs = [];
const started = Date.now();

for (const [index, state] of states.entries()) {
  const shared = {
    input: {
      toolName: state.tool,
      toolUseId: state.id,
      inputLine: state.input,
      resultText: state.resultText,
      isError: false,
      redacted: true,
      goalIndex: 0,
    },
    config: { ...config, minTokens: 0, chunkRelevance: false },
    cache: [],
    goal: state.goal,
    firstResult: false,
  };
  const jev = recording(jevAsker);
  const laya = recording(layaAsker);
  await runDiet({ ...shared, asker: jev.asker });
  await runDiet({ ...shared, asker: laya.asker });
  pairs.push({
    id: state.id,
    goal: state.goal,
    tool: state.tool,
    input: state.input,
    chars: state.chars,
    jev: slim(jev.box.captured),
    laya: slim(laya.box.captured),
  });
  if ((index + 1) % 50 === 0) {
    console.log((index + 1) + '/' + states.length + ' in ' + Math.round((Date.now() - started) / 1000) + 's');
  }
}

const document = {
  collectedAt: new Date().toISOString(),
  teacher: 'jev',
  student: 'laya/' + config.layaModel + '/' + config.layaSubfolder,
  count: pairs.length,
  pairs,
};
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(document, null, 2) + '\n');
console.log('wrote ' + out + ': ' + pairs.length + ' pairs in ' + Math.round((Date.now() - started) / 1000) + 's');

