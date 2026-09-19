# Context Diet 0.6.1

This release closes the remaining gaps against the 1.0 design document. Most of it is
hardening: packaging that matches the current official format, a privacy hole in the
development capture, full parity between the two hook transports, and an evaluation that
measures the real model instead of assuming it.

## Packaging

The repository now ships the portable Agent Plugins manifest as the single source of truth:

```text
plugin.json                  portable manifest, authoritative
mcp.json                     portable MCP config, authoritative
.codex-plugin/plugin.json    legacy overlay, generated
.mcp.json                    legacy MCP config, generated
```

`npm run sync:manifest` regenerates the two legacy files, and `npm run validate:plugin` fails
when they drift. Both contracts are validated: the portable files against the official
schemas vendored under `schemas/`, the legacy overlay against the ingestion rules the
shipped plugin-creator enforces. The two version carriers plus `package.json` must agree.

## Privacy

- `CONTEXT_DIET_CAPTURE` is redacted by default, exactly like the cache and the log. Raw
  capture now needs `CONTEXT_DIET_CAPTURE_UNREDACTED=1` and is documented as dangerous.
- A full-surface sweep found and fixed a real leak: the session goal and the compaction
  snapshot kept the prompt verbatim. Both are redacted at the point of capture now.

## Behaviour

- The command-hook fallback gained the Stop recovery guard, and both Stop guards now share one
  implementation with the MCP path. A parity test keeps the transports identical.
- Recovery reruns are classified as likely recoveries, possible reruns or invalidated reruns,
  and the stats row is named a rerun rate rather than a false-drop rate.
- Results that look like failures, or that redaction rewrote, need a much lower score before
  they can be dropped.

## Evaluation

The corpus grew from 26 to 112 labelled cases, and the CLI now separates the two modes:
`Mode: OFFLINE POLICY REGRESSION` against `Mode: LIVE JEV EVALUATION` with the model named.
Zero-failure samples report an exact one-sided 95% upper bound instead of a zero.

The live run against jev-1.13.0 on 2026-09-19 is published in
[docs/evals/jev-1.13-2026-09-19.md](evals/jev-1.13-2026-09-19.md). It matched 91 of 112 labels,
with 6 false drops and an exact 95% upper bound of 10.3%. The first run matched 78, and two
fixes came out of that measurement: concrete `needs_contents` criteria and the failure bar.
The six remaining misses are listed by case and stay in the corpus as regression fixtures.

## Also in this release

- `doctor` and `benchmark` commands, and a `sync:manifest` script.
- `eval:guards` for the subagent and quality guard corpora.
- Installation validation: an isolated clean-install check and tests for the 0.5.x and 0.6.0
  upgrade paths, missing and invalid keys, disabled mode, single-turn state and strict privacy.

## Upgrading

Nothing to migrate. Existing configuration keeps working, every added field has a safe
default, and the version appears in three places that the validator keeps in sync. Trust the
hooks again in `/hooks` after updating, and use `hooks/hooks.command.json` on a Codex build
without MCP tool hooks.

