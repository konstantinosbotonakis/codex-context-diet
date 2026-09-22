---
name: context-diet
description: Understand, tune, or debug Codex Context Diet, the plugin that asks TypeSafe's Jev which bulky tool results to replace with a bounded head and a note. Use when a session feels bloated with tool output, when the user asks why context is filling up, or when the keep threshold, token floor, or recorded decisions need review.
---

# Context Diet

The plugin exposes a persistent MCP server for direct judgement tools. Its plugin-discovered
`hooks/hooks.json` uses command handlers, matching the command-hook format loaded by SocratiCode.
`hooks/hooks.mcp.json` holds an optional MCP-tool hook transport. Both transports call the same
implementation functions; the default command hooks do not depend on the MCP server being ready.

The plugin judges every bulky tool result at PostToolUse and replaces the ones
the session no longer needs. Replaced results keep a bounded head and a note
saying what was dropped and which model judged it, so the model can re-run the
tool and a reader can tell what was a System One judgement and what was code.

## Delegate the narrow judgements

Complex reasoning stays with Codex. Classification, filtering, routing, ranking and simple
judgements go to the configured provider, Jev by default or a local checkpoint, through the
judgement tools this server exposes (`jev_boolean`, `jev_choice`, `jev_score`, and
`jev_ask` for several questions over one state in a single request). Name the steps that were
model judgements when a task mixed both. The `$codex-context-diet:jev` skill has the question
design rules and the cases that should stay in code.

## Configure

Config lives at `$PLUGIN_DATA/config.json` and survives reinstalls. It is never
committed. `loadConfig` falls back to the defaults for any missing or invalid
field, so a partial file is safe.

The settings worth tuning:

- `minTokens` (default 2000) is the estimated-token floor. Below it the plugin does no work at
  all. Raise it when too much is being touched, lower it when small results still cost too much.
- `keepThreshold` (default 0.5) is the Jev score at or above which something is kept. Lower
  means keep more.
- `dropThreshold` (default 0.25) is the score at or below which the contents count as stale.
  Anything in the band between the two thresholds keeps the result.
- `promptGuard` (off by default) adds one line of context to a prompt that looks
  production-affecting. It never blocks and it never rewrites. Turning it on costs one Jev call
  per prompt, on the critical path.
- the guard scores seven hazards independently, from live-system changes to external messages,
  billing, access, deletions and credentials, and names each one that fired.
- `logRetentionDays` (default 30) is how many days of the decision log survive rotation. The log
  rotates once a day, and `0` keeps everything.
- `pricePerMillionInputTokens` (default 0.042) prices the estimated cost in `stats`. Change it
  when TypeSafe changes the price.
- `privacyMode` (default `strict`) redacts secrets before Jev, the cache, and the log. `standard`
  redacts but ignores path exclusions, and `off` disables both.
- `neverSendPaths` are globs that stay on the machine in strict mode, and `neverSendTools` names
  tools whose results are never sent at all.
- `capsuleMaxChars` and its sibling budgets bound the evidence capsule that replaces a dropped
  result: failures, stack frames and summaries survive, the rest is an omission count.
- `dedupe` (default on) replaces a result that is identical to one the session already holds, and
  a file read stops counting as a duplicate once something writes to that file.
- `chunkRelevance` (default on) adds one extra request for exceptionally large dropped results,
  asking which chunks of a bounded sample belong in the capsule.
- `recoveryWindowMs` (default 10 minutes) bounds how late a rerun of a dropped result still
  counts as a recovery in the stats table.
- `toolPolicies` overrides the size gate or the thresholds per tool. Matches read `Bash:test`,
  `family:bash`, `output:test-log`, `Read` or `*`, and the last match wins. Run
  `node dist/cli.js policy` to see the resolution.
- `contextPressure` (default on) lowers the size gate once the session is estimated to carry
  40k, 90k or 150k retained tokens. It never lowers the keep threshold.
- `compactionResurrection` (default on) takes a bounded snapshot before Codex compacts and
  injects it on the first prompt after, once. `snapshotMaxChars` bounds that snapshot.
- `subagentGuard` (default on) gives subagents a result contract and judges their finished result
  before it returns to the parent, asking for one revision at most.
- `qualityGuard` (default off) checks the final message on Stop for an unfinished request, missing
  verification, a known failure or an unsupported claim, and asks for one continuation at most.

`dryRun: true` records every decision without replacing anything. Start there.

## Inspect

```bash
node dist/cli.js status   # config path, key source (never the key), cache size
node dist/cli.js stats    # usage table, with input tokens and the estimated cost
node dist/cli.js verify   # eight offline checks, no network
node dist/cli.js test     # one real request, needs a key
```

Set `debug: true` to append one line per decision to
`$PLUGIN_DATA/log/events.jsonl`: tool, action, reason, scores, character count.
The result text and the key are never written.

## Roll back

`enabled: false` in the config, or untrust the hook in `/hooks`. Neither needs a
reinstall. Hooks are a guardrail, not an enforcement boundary: a specialised
tool path can bypass them, and the plugin does nothing about that.
