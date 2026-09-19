# Context Diet 0.6.0

This is the release where Context Diet stops being only a diet. The hook still asks Jev which
bulky tool results a session can do without, and everything else in 1.0 grew around that one
decision: a local privacy boundary, evidence capsules, duplicate and recovery handling,
adaptive policy, a persistent MCP runtime, direct Jev tools, subagent and quality guards, and
an evaluation corpus that fails CI on a single false drop.

## Highlights

- **Privacy first.** A deterministic local pass redacts secrets before Jev, the cache or the
  log, and `neverSendPaths` / `neverSendTools` keep whole classes of output on the machine.
- **Evidence capsules.** A replaced result keeps its head, error lines, stack frames, summary
  lines and, for huge outputs, the chunks Jev says still matter. A 2 MB log becomes a 450-byte
  replacement that still names the failure.
- **Deterministic before semantic.** Excluded tools, size floors, byte-identical repeats and
  write invalidation never reach the model.
- **Recovery telemetry.** Re-runs of dropped results are counted, so the quality metric ships
  with the savings metric.
- **One persistent MCP process.** Roughly 40 ms less per qualifying tool result, and the same
  server exposes `jev_boolean`, `jev_choice` and `jev_score` to the assistant.
- **Subagents and compaction.** Subagents get a result contract and one revision at most;
  PreCompact snapshots plugin state and the next prompt gets it back once.
- **Guards that ship off.** The prompt guard and the Stop quality guard are opt-in, and both
  only ever add context or ask for one more step.
- **`doctor`, `benchmark` and richer `stats`.** Install health, local latency and a table that
  reports quantity, cost and quality without ever mixing context tokens with Jev tokens.

## Usage on my machine

```
                                  today      7 days     30 days
  sessions                           18          52          52
  results seen                      353       1,125       1,125
  results judged                    353       1,125       1,125
  results replaced                   53         152         152
    replaced share                  15%         14%         14%
  keeps                             300         973         973
  characters dropped          1,923,005   4,616,868   4,616,868
    net tokens avoided         ~480,751  ~1,154,217  ~1,154,217
  Jev calls                         330         923         923
  Jev input tokens            1,367,942   3,410,292   3,410,292
    estimated cost              $0.0575     $0.1432     $0.1432
  diet p50                      1209 ms     1265 ms     1265 ms
    diet p95                    3502 ms     3503 ms     3503 ms
```

Just over a million context tokens avoided across 30 days for about fourteen cents of Jev.
Local cost, with the model excluded, is 34.8 ms for a 2 MB result.

## Evaluation

`node dist/cli.js eval` runs 26 labelled cases offline and fails on any false drop. The corpus
currently reports 26 correct, 0 false drops, replacement rate 34.6%. `--live` runs the same
cases against the real model. The test suite is 231 tests, all offline.

## Upgrading

Nothing to migrate. Existing config files keep working, and every new field has a safe
default. After updating, trust the hooks again in `/hooks`: the lifecycle hooks now run
through the bundled MCP server. On a Codex build without `mcp_tool` handlers, copy
`hooks/hooks.command.json` over `hooks/hooks.json` and trust them again.

`node dist/cli.js doctor` answers most upgrade questions in one screen, and
`node dist/cli.js stats` shows whether decisions are landing.

