# Configuration

Context Diet reads `$PLUGIN_DATA/config.json`. The file is optional, survives reinstalls,
and is never committed. Every field is validated on load: a missing, unknown or invalid
field falls back to its default, and one bad value never discards the rest of the file.

`node dist/cli.js status` prints the resolved path and the key source.
`node dist/cli.js doctor` reports a config file that exists but does not parse, which is
the one failure a silent fallback would otherwise hide.

## Defaults

The full default file is printed under [Configure](../README.md#configure) in the README,
and a test keeps that block equal to `DEFAULT_CONFIG`. The table below groups every field
by what it changes.

## Core

| field | default | effect |
|---|---|---|
| `enabled` | `true` | master switch, checked before any file is read |
| `mode` | `"diet"` | `diet` replaces results, `observe` records decisions and replaces nothing |
| `dryRun` | `false` | forces observe behaviour while keeping the configured mode |
| `stateSource` | `"cache"` | `cache` keeps the rolling per-session digest, `off` is single-turn and writes nothing |
| `minTokens` | `2000` | estimated-token floor, checked before the key lookup and before the network |
| `keepThreshold` | `0.5` | score at or above which a result is kept |
| `dropThreshold` | `0.25` | score at or below which contents count as stale, with the band between resolving to keep |
| `truncateHeadChars` | `300` | characters retained in the note that replaces a result |
| `requestTimeoutMs` | `5000` | deadline for one Jev request, after which the hook fails open |
| `injectionGuard` | `true` | keep and annotate a result whose text addresses an agent |
| `model` | `"jev-latest"` | model id sent to TypeSafe |
| `neverDietTools` | `[]` | exact tool names exempt from the diet |

## Decision model

| field | default | effect |
|---|---|---|
| `provider` | `"jev"` | `jev` asks TypeSafe's hosted model, `laya` runs an open checkpoint locally |
| `layaPython` | `""` | python for the Laya worker; empty uses the managed venv, then `python3` |
| `layaModel` | `"convaiinnovations/laya"` | Hugging Face repo holding the checkpoints |
| `layaSubfolder` | `"multilingual"` | `multilingual`, `english`, `typed-decisions`, or empty for the repo root |
| `layaDevice` | `""` | torch device; empty means auto (`mps` or `cuda` when available) |
| `layaTimeoutMs` | `20000` | how long one local answer may take once the model is loaded |
| `layaWarmTimeoutMs` | `120000` | how long the first call may take while the model loads |

## Privacy

| field | default | effect |
|---|---|---|
| `privacyMode` | `"strict"` | `strict` redacts and honours path exclusions, `standard` only redacts, `off` disables both |
| `neverSendPaths` | `["**/.env", "**/.env.*", "**/*.pem", "**/*.key"]` | path globs kept entirely local in strict mode |
| `neverSendTools` | `[]` | tools whose results never leave the machine |

## Evidence capsules

| field | default | effect |
|---|---|---|
| `capsuleMaxChars` | `1200` | character cap for the capsule that replaces a dropped result |
| `capsuleMaxErrorLines` | `20` | error and failure lines kept |
| `capsuleMaxStackFrames` | `10` | stack frames kept |
| `capsuleMaxSummaryLines` | `8` | summary lines kept |

## Deterministic filters

| field | default | effect |
|---|---|---|
| `dedupe` | `true` | replace a byte-identical repeat with a note, without a Jev call |
| `recoveryWindowMs` | `600000` | how long after a drop an identical call still counts as a recovery |

## Chunk relevance

| field | default | effect |
|---|---|---|
| `chunkRelevance` | `true` | ask which chunks of an exceptionally large dropped result belong in the capsule |
| `chunkMinChars` | `20000` | result size below which chunk relevance is not attempted |
| `chunkMaxChars` | `24000` | sampled characters sent to the chunk request |
| `chunkMaxChunks` | `12` | maximum chunks in one request |
| `chunkMaxInclude` | `3` | maximum chunks that can end up in the capsule |

## Context pressure

| field | default | effect |
|---|---|---|
| `contextPressure` | `true` | let estimated retained context lower the size gate, never raise it |
| `pressureLowTokens` | `0` | floor at low pressure, where 0 keeps `minTokens` |
| `pressureModerateTokens` | `0` | floor at moderate pressure |
| `pressureHighTokens` | `1000` | floor at high pressure |
| `pressureCriticalTokens` | `750` | floor at critical pressure |
| `toolPolicies` | `[]` | per-tool overrides, last matching entry wins as a whole |

`toolPolicies` entries match on `*`, an exact tool (`Read`), a command category
(`Bash:test`), a family (`family:bash`) or an output class (`output:test-log`), and may set
`minTokens`, `keepThreshold` and `dropThreshold`. `node dist/cli.js policy` prints the
resolution for representative calls at each pressure stage.

## Session lifecycle

| field | default | effect |
|---|---|---|
| `compactionResurrection` | `true` | snapshot plugin state before compaction and inject it once after |
| `snapshotMaxChars` | `1500` | character cap for that snapshot |
| `subagentGuard` | `true` | hand subagents a result contract and judge their result before it returns |
| `subagentGuardThreshold` | `0.8` | score at or above which a subagent result passes a check |
| `subagentGuardMaxInterventions` | `1` | revisions one subagent can be asked for |
| `qualityGuard` | `false` | optional completion-quality check on Stop, off until the corpus supports it |
| `qualityGuardThreshold` | `0.8` | score at or above which a quality problem blocks completion |
| `qualityGuardMaxInterventions` | `1` | continuations one turn can be asked for |

## Prompt guard

| field | default | effect |
|---|---|---|
| `promptGuard` | `false` | add one warning line to a prompt that looks production-affecting, never blocks |
| `promptGuardThreshold` | `0.7` | score at or above which a hazard adds the line |
| `promptGuardTimeoutMs` | `3500` | deadline for a guard that runs while you wait |

## Storage, state and logging

| field | default | effect |
|---|---|---|
| `maxStateTokens` | `25000` | token budget for the state sent to Jev |
| `stateResultCapChars` | `4000` | character cap per result inside that state |
| `cacheMaxEntries` | `40` | newest entries kept per session |
| `cacheMaxBytes` | `262144` | size cap for one session cache file |
| `debug` | `false` | append one line per decision to `$PLUGIN_DATA/log/events.jsonl` |
| `logRetentionDays` | `30` | days of event log kept, rotated daily, where 0 keeps everything |
| `pricePerMillionInputTokens` | `0.042` | USD per million Jev input tokens, used for the stats cost line |

`apiKey` is also read from the config as the last key source. The other sources win, and
the key is never written to the log or the cache.

## Accepted aliases

The 1.0 design document proposed a few names that this implementation shortened. They are
accepted as aliases, and the canonical name wins when both are present:

| proposed name | canonical name |
|---|---|
| `duplicateDetection` | `dedupe` |
| `adaptiveContextPressure` | `contextPressure` |
| `chunkMaxCount` | `chunkMaxChunks` |

## Deliberate deviations from the proposed shape

| proposed field | decision | why |
|---|---|---|
| `evidenceCapsules` toggle | always on, no toggle | the capsule is the mechanism that makes a replacement safe. A drop without it loses evidence, so there is no safe off state |
| `signalSampling` toggle | always on, no toggle | sampling bounds what is sent and what is scanned. Turning it off would send whole results and weaken the privacy boundary |
| `signalSampleMaxChars` | no field | the sampler's budget is derived from the result cap and the state budget, so there is one bound to reason about instead of three that can disagree |
| `redactSecrets` | folded into `privacyMode` | redaction and path exclusions are one decision with three safe states, not two booleans that can contradict each other |
| `chunkRelevanceMinTokens` | `chunkMinChars` | the gate is measured in characters because token counts here are estimates, and a char gate cannot drift with an estimator change |
| `truncateHeadChars` | kept | same meaning |
| `stateResultCapChars` | kept | same meaning |
| `requestTimeoutMs` | kept | same meaning |

## Migration

Nothing needs migrating by hand. Every field added after 0.5.1 is additive with a safe
default, so an existing `config.json` keeps working, and unknown fields from a newer version
are ignored rather than rejected. The aliases above cover a config written against the 1.0
design document. After updating the plugin hook definition, review/trust it again in `/hooks`.
The default command hooks do not depend on the MCP server; `hooks/hooks.mcp.json` is an optional
MCP-tool transport.
