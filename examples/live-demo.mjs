#!/usr/bin/env node
/**
 * One genuine bulky result through the real endpoint.
 *
 *   npm run build && node examples/live-demo.mjs
 *
 * Needs a key: TYPESAFE_API_KEY, or ~/.typesafe_key (chmod 600), or apiKey in
 * the plugin config. Nothing here is simulated except the transcript.
 */
import { loadConfig } from '../dist/config.js';
import { resolveApiKey } from '../dist/key.js';
import { createAsker } from '../dist/codex/transport.js';
import { runDiet } from '../dist/codex/diet.js';

const env = process.env;
const config = loadConfig(env);
const { key, source } = resolveApiKey(config, env);

if (key === null) {
  console.log('No API key. Checked TYPESAFE_API_KEY, ~/.typesafe_key, and the apiKey field in ' +
    'the plugin config.');
  process.exit(1);
}

const command = 'npm test -- --reporter=verbose';
const block = [
  '  FAIL  src/b.test.ts > adds numbers',
  '  AssertionError: expected 2 to be 3',
  '    at src/b.test.ts:14:32',
  '    at runTest (node:internal/test_runner/test:791:23)',
  '',
].join('\n');
const resultText = ('> jest\n' + block).repeat(200);

const earlier = [
  {
    tool_use_id: 'demo-0a', tool_name: 'Read', at: '2026-09-18T00:00:00.000Z',
    input: 'src/b.test.ts', head: 'import { add } from "./add";', tail: '});', chars: 480,
    decision: 'keep', goal_index: 0,
  },
  {
    tool_use_id: 'demo-0b', tool_name: 'Bash', at: '2026-09-18T00:00:01.000Z',
    input: 'npm run typecheck', head: 'src/a.ts(3,1): error TS2304: Cannot find name', tail: '',
    chars: 210, decision: 'drop_result', goal_index: 0,
  },
];

const input = {
  toolName: 'Bash',
  toolUseId: 'demo-1',
  inputLine: command,
  resultText,
  isError: true,
  goalIndex: 0,
};
const goal = 'Fix the failing test in src/b.test.ts. Do not touch generated files.';

const started = Date.now();
const outcome = await runDiet({ input, config, cache: earlier, asker: createAsker(config, key, env), goal });
const ms = Date.now() - started;

const after = outcome.note ? outcome.note.length : outcome.entry.chars;
console.log('key source:    ' + source);
console.log('model:         ' + config.model);
console.log('latency:       ' + ms + ' ms');
console.log('scores:        keep_result=' + outcome.decision.keepResult.toFixed(3) +
  ' keep_call=' + outcome.decision.keepCall.toFixed(3) +
  ' injection=' + (outcome.decision.injection === null ? 'n/a' : outcome.decision.injection.toFixed(3)));
console.log('decision:      ' + outcome.decision.action + '  (' + outcome.decision.reason + ')');
console.log('chars:         ' + outcome.entry.chars + ' -> ' + after +
  '  (' + Math.round((1 - after / outcome.entry.chars) * 100) + '% smaller)');
console.log('blocked:       ' + outcome.blocked);
console.log('stdout keys:   ' + (outcome.stdout ? Object.keys(outcome.stdout).sort().join(',') : '(none)'));

if (outcome.blocked) {
  console.log('\nreason sent to the model:\n  ' + String(outcome.stdout.reason));
  console.log('\nnote tail:\n  ' + String(outcome.note).slice(-220).replace(/\n/g, '\n  '));
}

