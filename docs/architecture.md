# Architecture

Context Diet is a semantic context-management layer for Codex. It decides what a session keeps from each
bulky tool result, preserves the evidence that still matters, measures whether a decision had to be
undone, and adapts its size gate to the pressure the session is under.

Two rules hold everywhere:

1. Models provide signals. Deterministic code owns policy and side effects.
2. Every failure path keeps the original result. The plugin can lose an optimisation, never a session.

## The full pipeline

```text
                   Codex tool result
                          |
                          v
                Local privacy boundary
                 redact / block sending
                          |
                          v
                 Deterministic filters
                   size / exclusions
                    duplicates
                    invalidation
                          |
                          v
                    Signal sampler
                          |
                          v
                  Output classifier
                          |
              +-----------+-----------+
              |                       |
              v                       v
       normal decision        very large result
                                      |
                                      v
                            chunk relevance pass
              |                       |
              +-----------+-----------+
                          |
                          v
                     Jev signals
                          |
                          v
                deterministic policy
                          |
              +-----------+-----------+
              |                       |
              v                       v
            KEEP              Evidence Capsule
                                      |
                                      v
                                  telemetry
                                      |
                                      v
                             recovery detection
                                      |
                                      v
                              adaptive policy
```

The session lifecycle that feeds it:

```text
SessionStart -> goal/state capture
UserPromptSubmit -> optional prompt guard, resurrection snapshot
PostToolUse -> the pipeline above
SubagentStart/SubagentStop -> the result contract and its verdict
Stop -> optional completion guard, recovery advisory
PreCompact/PostCompact -> snapshot and its one-time injection
```

## The decision path

```text
PostToolUse
  |
  +-- adapter.ts
        |  skipped tool or never-send path?  keep, record the touch, stop
        |  redact secrets
        |  size gate = base minTokens, lowered by contextPressure, overridden by toolPolicies
        |  read the session cache, score duplicate and recovery
        |
        +-- duplicate?  deterministic_duplicate_drop, no model call
        +-- first result?  keep
        +-- no key or transport failure?  keep
        +-- otherwise  runDiet
              |  sample the result (head, signal lines, tail)
              |  one Jev request over the sampled state
              |  decideDiet applies the thresholds
              +-- drop  buildCapsule, optionally ask for chunk relevance
              +-- keep  annotate only when a hazard fired
```

`UserPromptSubmit` runs the optional prompt guard, carries the post-compaction snapshot, and records the
goal. `PreCompact` snapshots plugin-owned state, `PostCompact` records the event, and the next prompt
injects the snapshot once. `Stop` reports repeated recoveries once per session.

## Module map

| module | role |
|---|---|
| `src/codex/adapter.ts` | the PostToolUse entry point and the order of every check |
| `src/codex/diet.ts` | decision, note, cache entry, and the Jev call |
| `src/codex/dietState.ts` | the state Jev sees, with staged shrinking |
| `src/codex/promptGuard.ts` | the opt-in prompt guard questions and decision |
| `src/codex/session.ts` | SessionStart and UserPromptSubmit, goal capture, resurrection injection |
| `src/codex/compaction.ts` | snapshot building, PreCompact and PostCompact handling |
| `src/codex/transport.ts` | the real asker plus the deterministic test asker |
| `src/privacy.ts` | deterministic secret redaction and never-send paths |
| `src/sample.ts` | representative sampling of long results |
| `src/compressors/` | evidence capsules per output class, generic fallback |
| `src/dedupe.ts` | fingerprints, duplicate detection, write invalidation |
| `src/chunks.ts` | chunk splitting and relevance questions for very large results |
| `src/recovery.ts` | recovery inference from repeated calls |
| `src/policy.ts` | policy matching and effective thresholds |
| `src/pressure.ts` | the retained-context estimate and its stages |
| `src/stats.ts` | the usage table over caches and the event log |
| `src/mcp-server.ts` | the stdio MCP server: hook ops plus the Jev primitives |
| `src/codex/subagent.ts` | the subagent result contract and its four-question verdict |
| `src/codex/qualityGuard.ts` | the optional Stop guard and its continuation reasons |
| `src/codex/log.ts` | the redacted event log and its daily rotation |
| `src/codex/keyWarning.ts` | the once-per-hour "Jev was skipped" line |
| `src/eval.ts` and `evals/` | the offline decision corpus and its report |
| `src/doctor.ts` | the offline install health check |
| `src/bench.ts` | the local latency benchmark behind `benchmark` |

Command entry points (`adapter-main.ts`, `session-main.ts`, `compaction-main.ts`, `subagent-main.ts`,
`stop-main.ts`, `quality-guard-main.ts`) back the plugin-discovered `hooks/hooks.json` file, matching
Codex plugins that use command hooks. `hooks/hooks.mcp.json` retains the optional MCP-tool transport;
`hooks/hooks.command.json` stays as a parity/fallback copy.

Both transports call the same functions, and a parity test keeps it that way:

| event | MCP tool | command entry | shared implementation |
|---|---|---|---|
| PostToolUse | `post_tool_use` | `adapter-main.js` | `adapter.main` |
| SessionStart | `session_event` | `session-main.js` | `session.main` |
| UserPromptSubmit | `prompt_guard` | `session-main.js` | `session.main` |
| SubagentStart, SubagentStop | `subagent_start`, `subagent_stop` | `subagent-main.js` | `subagent.handleSubagent` |
| PreCompact, PostCompact | `pre_compact`, `post_compact` | `compaction-main.js` | `compaction.handleCompaction` |
| Stop recovery guard | `stop_guard` | `stop-main.js` | `stopGuard.handleStopGuard` |
| Stop quality guard | `quality_guard` | `quality-guard-main.js` | `qualityGuard.handleStop` |

## Storage

Everything lives under `$PLUGIN_DATA` and survives reinstalls:

```text
config.json                     the only file a user edits
sessions/<key>.results.jsonl    one line per judged result, bounded, newest last
sessions/<key>.touches.jsonl    paths a call may have written
sessions/<key>.recoveries.jsonl drops that were re-run
sessions/<key>.json             session record and the last three goals
state/resurrection-<key>.md     the compaction snapshot, consumed once
state/key-warning.json          the once-per-hour key warning marker
state/stop-guard.json           the once-per-session recovery advisory marker
log/events.jsonl                debug events, rotated daily
```

Cache lines carry the decision, the reason, the Jev scores, the call index, the result hash and, for
reads, the resource path. No line carries the full result; the head and tail stored with each entry are
bounded and already redacted.

## Invariants to keep when changing this code

- Fail open. Any new failure path returns the untouched result.
- Cheap deterministic checks run before Jev: excluded tools, never-send paths, size, duplicates, hashes.
- Uncertainty keeps. The band between the thresholds resolves to keep, and chunk selection drops only
  what Jev scored below the drop threshold.
- Secrets stay local. Redaction runs before the request, before the cache write, and before the log write.
- The transcript is never read. The plugin owns its own state and treats the transcript format as unstable.
- Measured claims only. Latency numbers come from `npm run bench:hooks`, cost from the stats table, and
  quality from the recovery rate.

## Verification

`npm test` covers the decision path, the hook entry points, the MCP protocol and the storage formats.
`node dist/cli.js verify` runs eight offline checks over the decision path, `node dist/cli.js eval`
runs the 26-case decision corpus with one false drop failing the run, and `node dist/cli.js doctor`
checks the install, the key, the storage, the hooks and the MCP runtime without sending anything.
`npm run validate:plugin` mirrors the plugin ingestion schema. `node dist/cli.js benchmark` and
`npm run bench:hooks` measure the transports, and `node scripts/bench-stages.mjs` measures each local
stage. Numbers live in [performance.md](performance.md).
