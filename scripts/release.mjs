#!/usr/bin/env node
/**
 * Cut a release: bump every manifest, run the gates, commit, tag, push, publish.
 *
 *   npm run release -- patch
 *   npm run release -- minor
 *   npm run release -- 0.4.0
 *   npm run release -- patch --dry-run
 *   npm run release -- patch --skip-github
 *
 * The version lives in three places and they drift apart when a human edits
 * them one at a time. This script owns all three, and refuses to run at all
 * unless they agree to begin with.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFESTS = ['package.json', 'plugin.json'];
const LOCKFILE = 'package-lock.json';

const fail = (message) => {
  console.error('release: ' + message);
  process.exit(1);
};

// stderr is dropped: probing git for a previous tag is expected to fail on the
// first release, and a stray "fatal:" line reads like the script broke.
const capture = (cmd, args) =>
  execFileSync(cmd, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

const run = (cmd, args, quiet = false) =>
  execFileSync(cmd, args, {
    cwd: root,
    stdio: quiet ? 'pipe' : 'inherit',
    encoding: 'utf8',
  });

const readJson = (file) => JSON.parse(readFileSync(join(root, file), 'utf8'));
const writeJson = (file, value) =>
  writeFileSync(join(root, file), JSON.stringify(value, null, 2) + '\n');

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const skipGithub = argv.includes('--skip-github');
const bump = argv.find((arg) => !arg.startsWith('--'));

if (!bump) fail('usage: node scripts/release.mjs <patch|minor|major|X.Y.Z> [--dry-run] [--skip-github]');

const versions = MANIFESTS.map((file) => readJson(file).version);
if (new Set(versions).size !== 1) {
  fail(
    'manifests disagree before the bump: ' +
      MANIFESTS.map((file, i) => file + ' is ' + versions[i]).join(', ') +
      '. Fix them first.',
  );
}
const current = versions[0];

const explicit = /^\d+\.\d+\.\d+$/.test(bump);
let next;
if (explicit) {
  next = bump;
} else {
  const [major, minor, patch] = current.split('.').map(Number);
  if (bump === 'major') next = major + 1 + '.0.0';
  else if (bump === 'minor') next = major + '.' + (minor + 1) + '.0';
  else if (bump === 'patch') next = major + '.' + minor + '.' + (patch + 1);
  else fail('unknown bump "' + bump + '"; expected patch, minor, major or X.Y.Z');
}

const tag = 'v' + next;
console.log('release: ' + current + ' -> ' + next + (dryRun ? ' (dry run)' : ''));

if (capture('git', ['status', '--porcelain']) !== '') fail('working tree is dirty. Commit or stash first.');
const branch = capture('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
if (branch !== 'main') fail('on branch ' + branch + ', expected main.');
if (capture('git', ['tag', '--list', tag]) !== '') fail('tag ' + tag + ' already exists.');
if (next === current) fail('version is already ' + current);

// Every gate runs before a single file changes, so a failure leaves the tree
// exactly as it was found.
const gates = [
  ['npm', ['test']],
  ['npm', ['run', 'typecheck']],
  ['npm', ['run', 'build']],
  ['node', ['dist/cli.js', 'verify']],
];
for (const [cmd, args] of gates) {
  console.log('release: ' + cmd + ' ' + args.join(' '));
  run(cmd, args);
}

const touched = [];
for (const file of MANIFESTS) {
  const json = readJson(file);
  json.version = next;
  writeJson(file, json);
  touched.push(file);
}

const lock = readJson(LOCKFILE);
lock.version = next;
if (lock.packages && lock.packages['']) lock.packages[''].version = next;
writeJson(LOCKFILE, lock);
touched.push(LOCKFILE);

if (dryRun) {
  run('git', ['checkout', '--', ...touched]);
  console.log('release: dry run finished. Nothing was committed, tagged or pushed.');
  process.exit(0);
}

try {
  run('git', ['add', '-A']);
  run('git', ['commit', '-m', 'Release ' + tag]);
  run('git', ['tag', '-a', tag, '-m', tag]);
  run('git', ['push', 'origin', 'main']);
  run('git', ['push', 'origin', tag]);
} catch (error) {
  console.error('release: git failed after the version bump.');
  console.error('release: the commit and tag may exist locally. Inspect with git log and git tag.');
  console.error('release: to undo, git tag -d ' + tag + ' && git reset --hard HEAD~1');
  fail(error instanceof Error ? error.message : String(error));
}

console.log('release: pushed ' + tag);

if (skipGithub) process.exit(0);

let previous;
try {
  previous = capture('git', ['describe', '--tags', '--abbrev=0', tag + '^']);
} catch {
  previous = '';
}
const range = previous ? previous + '..' + tag : tag;
const commits = capture('git', ['log', '--pretty=format:- %s', '--invert-grep', '--grep=^Release v', range]);
const notes = commits || '- No changes since the last tag.';
const notesFile = join(tmpdir(), 'context-diet-' + tag + '-notes.md');
writeFileSync(notesFile, 'Changes in ' + tag + ':\n\n' + notes + '\n');

try {
  run('gh', ['release', 'create', tag, '--title', tag, '--notes-file', notesFile]);
  console.log('release: published ' + tag);
} catch {
  console.error('release: the tag is pushed but the GitHub release was not created.');
  console.error('release: retry with gh release create ' + tag + ' --notes-file ' + notesFile);
}
