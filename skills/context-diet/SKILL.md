---
name: context-diet
description: Understand, tune, or debug Codex Context Diet, the plugin that asks TypeSafe's Jev which bulky tool results to replace with a bounded head and a note. Use when a session feels bloated with tool output, when the user asks why context is filling up, or when the keep threshold, token floor, or recorded decisions need review.
---

# Context Diet

The plugin judges every bulky tool result at PostToolUse and replaces the ones
the session no longer needs. Replaced results keep a bounded head and a note
saying what was dropped, so the model can re-run the tool.

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
- `logRetentionDays` (default 30) is how many days of the decision log survive rotation. The log
  rotates once a day, and `0` keeps everything.
- `pricePerMillionInputTokens` (default 0.042) prices the estimated cost in `stats`. Change it
  when TypeSafe changes the price.

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
