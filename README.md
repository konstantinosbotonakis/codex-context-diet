# Context Diet

A Codex plugin that asks TypeSafe's [Jev](https://typesafe.ai/) which bulky tool results the session still needs, and replaces the rest with a bounded head plus a one-line note.

Long sessions fill up with tool output: test logs, build noise, large file reads, MCP payloads. Once a result lands in the transcript it is re-sent on every later request until Codex compacts the conversation. Compaction runs after the context is already bloated. This plugin works at the moment the result is produced.

## How it works

1. `PostToolUse` fires after a tool produces output. The adapter reads one JSON payload on stdin.
2. Results are left alone when they are small, come from `apply_patch`, name a tool in `neverDietTools`, or arrive as the first result of a session.
3. Everything else goes to Jev in one request with two or three questions: does the full text still need to stay, does the fact that the call happened still matter, and does the output look like text addressed to an agent rather than to a reader.
4. When the body is stale, Codex replaces the tool result with the first `truncateHeadChars` characters and a note naming what ran and how much was dropped. The model can re-run the tool if it needs the rest.
5. Every decision, including keep, is appended to a per-session digest cache. That cache is the history Jev sees next time, so the judgement improves as the session goes on.

An injection verdict never blocks and never edits. It forces the result to be kept and adds one line of developer context. A false positive must not change what the model can see.

### The three stdout shapes

There are exactly three, and nothing else is ever written to stdout:

| shape | when |
|---|---|
| `{"decision":"block","reason":...,"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":...}}` | the result was replaced; Codex swaps in the head and note |
| `{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":...}}` | the result was kept and the injection guard flagged it; no `decision` field means the result is untouched |
| no output | keep, every error, and every exempt case |

## Measured

One real session, `codex-cli 0.154.0`, three tool results of 40,106 characters each, produced by a model-written script that handed a 5,000-line command to `exec_command`:

| result | decision | what the model received |
|---|---|---|
| first | `keep` - the first result of a session is exempt | 41,444 characters |
| second | `drop_result` | **567 characters**: the head plus the note |
| third | `drop_result` | **567 characters** |

Input tokens on the request that followed a new bulky result: **+17,309 with the hook untrusted, +553 with it firing.** One run each, same prompt, not a controlled experiment - but the marginal cost of a 40k-character result went from five figures to three.

Two things worth knowing before installing:

- The manifest is the legacy-compatible shape: top-level `interface`, hooks discovered at `hooks/hooks.json`. With the portable `$schema` / `extensions.com.openai` manifest, the skill still loaded but the hooks did not, on `codex-cli 0.154.0`.
- The replacement returns `decision: "block"`. In code mode that rejects the nested `exec_command` promise with the note, which is the point: a model-written script then cannot read the full output and print it back into the transcript. `continue: false` was measured and does not achieve this - the promise still resolves with the full text, and the script re-exposed all 41k characters.

## Install

The plugin needs Node 18 or newer on `PATH`, because the hooks are Node processes.

```bash
codex plugin marketplace add konstantinosbotonakis/codex-context-diet
codex plugin add codex-context-diet@context-diet
```

The marketplace is named `context-diet` inside this repository, which is why the second
command carries a qualifier. Installing from a checkout works the same way:

```bash
codex plugin marketplace add /path/to/codex-context-diet
codex plugin add codex-context-diet@context-diet
```

Then review and trust the hooks in `/hooks`. Codex skips plugin hooks until you do, and that is the correct behaviour: a hook can replace what the model sees. Untrusting it again is the rollback.

There is no build step at install time. `dist/` is committed, because a plugin installed from git cannot run `npm run build`.

## Configure

Config lives at `$PLUGIN_DATA/config.json`, survives reinstalls, and is never committed. Any missing or invalid field falls back to its default, so a partial file is safe.

```json
{
  "enabled": true,
  "mode": "diet",
  "dryRun": false,
  "stateSource": "cache",
  "minTokens": 2000,
  "keepThreshold": 0.5,
  "truncateHeadChars": 300,
  "maxStateTokens": 25000,
  "stateResultCapChars": 4000,
  "requestTimeoutMs": 2500,
  "injectionGuard": true,
  "model": "jev-latest",
  "neverDietTools": [],
  "cacheMaxEntries": 40,
  "cacheMaxBytes": 262144,
  "debug": false
}
```

| field | meaning |
|---|---|
| `enabled` | master switch; `false` exits before anything else |
| `mode` | `diet` or `observe`; observe records decisions and replaces nothing |
| `dryRun` | forces observe behaviour regardless of `mode` |
| `stateSource` | `cache` (default) keeps a rolling per-session digest; `off` is single-turn and writes nothing to disk |
| `minTokens` | estimated-token floor; below it there is no key lookup and no network call |
| `keepThreshold` | Jev score at or above which something is kept |
| `truncateHeadChars` | characters of the result retained in the note |
| `neverDietTools` | exact tool names to exempt |
| `debug` | append one line per decision to `$PLUGIN_DATA/log/events.jsonl` |

Reading Codex's own transcript is deliberately not implemented. The format is documented as
not a stable interface for hooks, so the plugin keeps its own state instead. A transcript
reader is on the roadmap as an opt-in enrichment.

### The API key

Resolution order: `TYPESAFE_API_KEY`, then `~/.typesafe_key` (override the path with `TYPESAFE_KEY_FILE`), then `apiKey` in the config. The key is never written to stdout, stderr, the log, or the cache. Only its source is ever reported.

```bash
printf %s "$YOUR_KEY" > ~/.typesafe_key && chmod 600 ~/.typesafe_key
```

## Commands

```bash
node dist/cli.js status   # config path, key source, data directory, cached sessions
node dist/cli.js verify   # eight checks over the decision path, fully offline
node dist/cli.js test     # one real request to Jev; the only command that needs a key
```

`verify` runs the harness twice: once with a working fake asker, where every check must pass, and once with an asker that always throws, where `asker-contract` and `decide-call` must fail. The second run is the proof that a broken transport fails closed instead of inventing a decision.

## What is never dieted

- `apply_patch` and its `Edit` / `Write` aliases. Patch output is the record of what changed: small and load-bearing.
- The first result of a session. With one entry there is nothing to reason about relative to, and the plugin should not remove the model's only view of what happened.
- Anything under `minTokens`, which costs nothing to skip: the floor is checked before the key and before any file is read.
- Hosted tools such as web search, which never reach the PostToolUse hook path.

Hooks are a guardrail, not an enforcement boundary. Some specialised tool paths can opt out of the default hook path, and this plugin does not try to prevent that.

## Measuring the effect

Codex records token usage per turn in the session rollout as `token_usage_record` events. Compare the request after a diet against the request before it, and compare that delta against a baseline recorded from the same command with the plugin disabled or untrusted. A single before/after pair on its own cannot separate the diet from ordinary turn-to-turn growth.

## Differences from upstream

The core is a port of [fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction). Three things changed:

- The Claude Code entry point is gone. The outcome here is binary, because a tool result can only be replaced or left alone; `keep_call` narrows the note rather than changing whether a replacement happens.
- `buildDietState` replaces the ported `fitState` for the diet path. `fitState` renders results as `ok, N chars (omitted)` notes, which would discard the digest that makes the cache useful. The staged-shrink discipline is preserved; the shape is not.
- The injection guard only annotates, and forces keep, so its line travels in the context-only warning rather than in a replacement note.

## Development

```bash
npm install
npm test && npm run typecheck && npm run build
```

`dist/` is committed, so a change under `src/` is not shipped until `npm run build` runs and `dist/` is staged with it. `CONTEXT_DIET_TEST_ANSWERS` and `CONTEXT_DIET_CAPTURE` exist for tests and for recording real payloads; neither should be set in a normal session.

## Attribution

Derived from `tamaratran/fast-jev-compaction` (MIT) at commit `e3f262a7f4d42bd8dd32ced30d26176f7cb545b0`. The upstream copyright notice is retained in `LICENSE`.
