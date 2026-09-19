# Release map

The 1.0 design grouped the work into five releases so the architecture could land in
migration-safe steps. This repository delivered the whole architecture in one unreleased
stretch of work on top of 0.5.1, so the grouping below is a reading guide to the capability
set and the commit history rather than five separate releases.

| version | capability group | state |
|---|---|---|
| 0.6 | manifest compliance, privacy layer, signal sampler, Evidence Capsules, duplicate detection, recovery telemetry | shipped together in 0.6.0 |
| 0.7 | deterministic compressors, richer capsules, chunk relevance | shipped in 0.6.0 |
| 0.8 | persistent MCP runtime, direct Jev MCP tools, latency benchmark | shipped in 0.6.0 |
| 0.9 | adaptive tool policy, adaptive context pressure, statistics, evaluation framework | shipped in 0.6.0 |
| 1.0 | Context Resurrection, subagent integration, optional Stop quality guard, evaluation corpus, documentation | shipped in 0.6.0 |

Version 0.5.1 already carried the statistics table, log rotation and the key warning. The
version appears in three places that must agree: `package.json`, `plugin.json` and the
generated `.codex-plugin/plugin.json`. `npm run validate:plugin` fails when they disagree.
The 0.6.0 release shipped the 1.0 capability set; 0.6.1 closed the packaging, privacy, parity
and evaluation gaps against the design document, and its live evaluation is published under
`docs/evals/`.

## Cutting a release
### 0.7.0

Pluggable decision-model providers. `provider` selects TypeSafe's Jev (default) or a local open
Laya checkpoint, with `setup`, `provider set`, `provider warm` and a calibration script. The
measured comparison and the honest state of the stock Laya checkpoints are in `docs/providers.md`.


```bash
npm run release -- minor            # 0.6.0 -> 0.7.0
npm run release -- patch            # 0.6.0 -> 0.6.1
npm run release -- 0.7.0            # explicit version
npm run release -- patch --dry-run  # show the plan, change nothing
```

The script refuses to start unless the tree is clean and on `main`, checks that the two
manifests already agree, then runs the tests, the typecheck, the build and the offline
verification before it writes the new version, syncs `package-lock.json`, commits, tags
`vX.Y.Z`, pushes, and publishes a GitHub release listing the commit subjects since the
previous tag. `--skip-github` stops after the tag.

CI runs the same offline gates on every push: manifest validation, typecheck, build, the
decision corpus, the test suite, the CLI doctor, and a check that the committed `dist/`
matches the current `src/`.

## What is not in 0.6.0

- transcript reading: the Codex transcript format is documented as unstable for hooks, so the
  plugin keeps its own state instead
- released evaluation numbers against a large private workload: the corpus and the harness
  ship, the numbers in the README come from the runs described there
