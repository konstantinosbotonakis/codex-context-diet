#!/usr/bin/env node
/**
 * Mine real tool results out of this machine's Codex sessions.
 *
 * Real states beat synthetic ones for calibration: they are the outputs this
 * plugin actually meets. The goal is the last user message before the call, the
 * input is the call's own arguments, and the result is the tool output, redacted
 * with the same rules the hooks apply before anything is sent anywhere.
 *
 *   node scripts/mine-session-results.mjs --limit 400 --out /tmp/cd-mined.json
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { redactText } from '../dist/privacy.js';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? (args[index + 1] ?? fallback) : fallback;
};
const limit = Number(flag('--limit', '400'));
const out = flag('--out', '/tmp/cd-mined.json');
const MIN_CHARS = 4_000;
const MAX_STATES_PER_SESSION = 4;

function rolloutFiles(root, found = []) {
  let entries = [];
  try {
    entries = readdirSync(root);
  } catch {
    return found;
  }
  for (const name of entries) {
    const path = join(root, name);
    let stat;
    try {
      stat = statSync(path);
    } catch {
      continue;
    }
    if (stat.isDirectory()) rolloutFiles(path, found);
    else if (name.endsWith('.jsonl')) found.push({ path, mtime: stat.mtimeMs });
  }
  return found;
}

const home = homedir();
const files = [...rolloutFiles(join(home, '.codex', 'sessions')), ...rolloutFiles(join(home, '.codex', 'archived_sessions'))]
  .sort((left, right) => right.mtime - left.mtime);

const SENSITIVE = /(^|[/\\])(\.env|\.env\.[a-z]+|[^/\\]*\.(pem|key|p12|pfx))$/i;
const seen = new Set();
const states = [];

for (const file of files) {
  if (states.length >= limit) break;
  let lines;
  try {
    lines = readFileSync(file.path, 'utf8').split('\n');
  } catch {
    continue;
  }
  const calls = new Map();
  let goal = '';
  let taken = 0;
  for (const line of lines) {
    if (line.length === 0) continue;
    let item;
    try {
      item = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = item.payload ?? {};
    if (payload.type === 'message' && payload.role === 'user') {
      const content = Array.isArray(payload.content) ? payload.content : [];
      const text = content.map((part) => (part && typeof part.text === 'string' ? part.text : '')).join(' ').trim();
      if (text.length > 0 && !text.startsWith('<environment_context>')) goal = text.slice(0, 300);
      continue;
    }
    if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
      if (typeof payload.call_id === 'string') {
        calls.set(payload.call_id, { name: payload.name ?? 'tool', args: payload.arguments ?? payload.input ?? '' });
      }
      continue;
    }
    if (payload.type !== 'function_call_output' && payload.type !== 'custom_tool_call_output') continue;
    if (taken >= MAX_STATES_PER_SESSION || states.length >= limit) break;
    const output = typeof payload.output === 'string' ? payload.output : '';
    if (output.length < MIN_CHARS) continue;
    const call = calls.get(payload.call_id) ?? { name: 'tool', args: '' };
    const rawArgs = typeof call.args === 'string' ? call.args : JSON.stringify(call.args);
    if (SENSITIVE.test(rawArgs)) continue;
    const document = JSON.parse('{}');
    void document;
    const redacted = redactText(output, 'strict').text;
    const fingerprint = createHash('sha256').update(redacted.slice(0, 2000)).digest('hex');
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    taken += 1;
    states.push({
      id: 'mined-' + states.length,
      source: file.path.split('/').slice(-3).join('/'),
      goal: goal || 'continue the work',
      tool: call.name,
      input: rawArgs.slice(0, 200),
      chars: output.length,
      resultText: redacted,
    });
  }
}

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ minedAt: new Date().toISOString(), count: states.length, states }, null, 2) + '\n');
console.log('wrote ' + out + ': ' + states.length + ' real results from ' + files.length + ' sessions');

