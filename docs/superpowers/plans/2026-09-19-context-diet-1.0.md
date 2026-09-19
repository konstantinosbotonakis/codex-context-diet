# Context Diet 1.0 implementation plan

Date: 2026-09-19. Baseline: 0.5.1, released. Repo: `konstantinosbotonakis/codex-context-diet`.

This plan turns the plugin into a semantic context-management layer for Codex. It maps each
objective section to one phase. Every phase ends with tests, docs, and a commit, in that order.

## Verified platform facts

These were checked against the live system, not assumed.

1. The plugin manifest ingestion schema is the one mirrored by the installed plugin-creator
   validator at `/Users/kb/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py`.
   It accepts exactly `id, name, version, description, skills, apps, mcpServers, interface,
   `author, homepage, repository, license, keywords`, requires `author.name` and
   `interface.defaultPrompt`, and rejects `hooks`, `$schema`, and `extensions` as unknown
   fields. Hook discovery for plugins happens through the default `hooks/hooks.json`.
2. Ingestion reads `.codex-plugin/plugin.json` when it exists. A scratch install with both
   manifests present on codex-cli 0.153.4 recorded the `.codex-plugin` version (9.9.9-portable)
   and copied the root `plugin.json` (1.1.1-root) only as a legacy file. Both files are kept in
   sync for older Codex versions and for the update skill.
3. Hooks (developers.openai.com/codex/hooks.md) support `command` and `mcp_tool` handlers.
   Lifecycle events include `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`,
   `PostCompact`, `UserPromptSubmit`, `Stop`, `SubagentStop`, `SubagentStart`, `SessionStart`,
   `SessionEnd`, and `Interrupt`. `PreCompact` and `PostCompact` carry `trigger` of `manual` or
   `auto`. An `mcp_tool` handler names an already-connected server and tool, with argument
   templates expanded from the event. Additional context is capped at roughly 2500 tokens by
   default and configurable per handler.
4. Hook payloads carry no token or context-usage fields. Context pressure must therefore be a
   plugin-owned estimate, with the rollout transcript as an optional enrichment.
5. Jev (docs.typesafe.ai, confirmed by live calls): `POST /v1/systemone` with
   `model: jev-latest`, question types `noul`, `choice`, and `score`, a response carrying
   `answers` and `usage.input_tokens`, and a published price of $0.042 per million input tokens
   with output tokens free.

## Architecture decisions

- Models provide signals, deterministic policy owns decisions and side effects. Jev scores never
  act directly.
- Every new feature is config-gated with a conservative default, and all failure paths keep the
  original result.
- The command-hook transport stays the default. The MCP runtime is opt-in until its benchmark
  proves a win, and it reuses the same decision modules so behaviour cannot fork.
- The privacy boundary runs before any Jev call and before any cache or log write.
- Capsules only replace a head when extraction produces something at least as useful, and they
  are always bounded.

## Phases

### Phase 1, portable manifest compliance (section 5)

Add `.codex-plugin/plugin.json` with the accepted shape, keep root `plugin.json` in sync, add
`author`, `homepage`, `repository`, and `interface.defaultPrompt`, and teach the release script to
bump all three version carriers. Add `scripts/validate-plugin.mjs` plus a `validate:plugin` npm
script and a CI step, mirroring the ingestion rules, including a check that the two manifests
agree on version and content. Evidence: the official validator passes; a scratch install
discovers the plugin and its hooks.

### Phase 2, local privacy boundary (section 6)

New `src/privacy.ts` with deterministic pattern detection for keys, tokens, JWTs, PEM blocks,
passwords, connection strings, and `.env` content, plus path exclusions. Modes `strict`,
`standard`, `off` with a secure default. Enforcement points: the diet state builder, the prompt
guard state, cache writes, and the debug log. Tests assert a sentinel secret never appears in the
Jev request body, the log, or the cache. Secret classification stays local.

### Phase 3, signal sampler (section 7)

New `src/sample.ts`. Long results are reduced to a budgeted sample of head, high-signal lines
(errors, warnings, failures, exceptions, file:line, summaries, totals, exit status), and tail.
Per-line caps stop pathological output from flooding the sample. Tests use a 100k-character log
whose only useful signal sits in the middle and at the end.

### Phase 4, evidence capsules (section 8)

New `src/compressors/` with a generic extractor plus test-log, build-log, compiler, stack-trace,
JSON, git, file-read, and MCP extractors, all deterministic. `buildNote` emits a bounded capsule
with command, exit status, extracted failures, omission count, and re-run hint. Configuration
carries independent budgets for capsule size, error lines, stack frames, and summary lines.

### Phase 5, duplicate elimination (section 10)

Fingerprint tool results by normalised input plus content hash. An identical, still-valid result
becomes `deterministic_duplicate_drop` with no Jev call. File reads are invalidated by later
writes or patches to the same path. Tests cover exact reruns, invalidation, and the no-network
guarantee.

### Phase 6, chunk relevance (section 9)

For results above a very-large threshold, split into bounded chunks and ask one Jev request with
`chunk_1_needed` style questions. Only strongly relevant chunks join the capsule, bounded by
maximum chunks, sampled characters, and state size. Uncertainty keeps the result. Tests use a
fake asker, including a malformed answer path that must keep.

### Phase 7, recovery telemetry (section 11)

Record a bounded drop ledger per session, then detect likely recoveries: identical command reruns,
file re-reads before modification, repeated MCP calls, repeated git inspections. Metrics: replaced
results, deterministic removals, estimated tokens removed, recovery reruns, recovery rate, calls
until recovery, net useful replacements. `stats` gains the new rows and documents the inference.

### Phase 8, per-tool policy (section 12)

`toolPolicies` maps matchers to policy overrides. Matchers resolve by exact tool, tool family,
recognised command category, and output class. `node dist/cli.js policy` explains which policy
matched and why. Defaults reproduce today's behaviour exactly.

### Phase 9, adaptive context pressure (section 13)

A conservative plugin-owned retained-context counter, updated on every appended result and
derived from the session cache, yields stages `low`, `moderate`, `high`, `critical` and scales
`minTokens` per stage. Safety rules around uncertainty and reproducibility stay hard limits. The
stage is visible in `status`, `stats`, and debug events. Optional transcript enrichment stays
opt-in and fail-open.

### Phase 10, persistent MCP runtime (section 14)

An MCP server exposing `context_diet.post_tool_use`, `prompt_guard`, `stop_guard`, and
`session_event`, reusing the same decision modules, with in-memory session state and disk
persistence for restart recovery. The command hooks remain the default and the fallback.
`scripts/bench-hooks.mjs` measures process startup, p50 and p95 hook latency, Jev latency, and
local processing latency before and after. The README documents measured numbers only.

### Phase 11, Jev MCP tools (section 15)

Expose `jev_boolean`, `jev_choice`, and `jev_score` through `.mcp.json`, with request-size limits,
redaction, validated answers, configured model and timeouts, and safe failure. Add a skill
explaining when to reach for Jev instead of a large reasoning model.

### Phase 12, compaction resurrection (section 16)

`PreCompact` snapshots compact plugin-owned session state: goal, recent decisions, unresolved
failures, modified files, capsules, and removed commands. `PostCompact` injects the bounded
snapshot back as additional context. `Stop` and `SessionEnd` close the ledger. Payloads follow the
documented fields and the whole path fails open.

### Phase 13, documentation and 1.0 release

README rewritten around the semantic layer, a migration note for 0.x configurations, CHANGELOG
entries per phase, and the release flow. 1.0 ships only when every acceptance criterion above has
fresh evidence.

## Test and verification strategy

- Pure logic lands as unit tests beside the module; hook entry points keep their process-level
  tests that run the built `dist/` code.
- Fixtures cover real log shapes for each compressor. Secret tests use sentinels only.
- Every phase runs `npm test`, `npm run typecheck`, `npm run build`, `node dist/cli.js verify`,
  and `npm run validate:plugin`, plus the phase-specific proof.
- Nothing is claimed without a measurement: latency, cost, and recovery numbers come from the
  benchmark and telemetry outputs.

## Risks and mitigations

- Manifest migration could break older Codex versions. Both manifests stay present, CI enforces
  agreement, and a scratch install proves discovery.
- The MCP runtime could regress behaviour. It is opt-in, shares the decision modules, and is
  benchmarked before it is recommended.
- Chunk relevance could add cost. It is limited to very large outputs and bounded by caps.

