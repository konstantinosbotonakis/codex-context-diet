# Performance

Context Diet is an optimisation product, so its own cost is part of the contract. Every
number below is measured on the development machine (macOS, arm64, Node 24.11.1) and every
one is reproducible with a command in this repository. Nothing here is an estimate.

## Local stages on one large result

`node scripts/bench-stages.mjs [chars] [repeats]` times each local stage in isolation, then
the whole hook with the test asker standing in for Jev. Medians:

| stage | 200,000 chars | 2,000,000 chars |
|---|---|---|
| secret scan | 0.3 ms | 3.0 ms |
| signal sample | 1.0 ms | 9.8 ms |
| token estimate | 1.5 ms | 14.1 ms |
| fingerprint | 0.8 ms | 8.1 ms |
| full hook, local only | 4.3 ms | 34.8 ms |

Scaling is linear. A 2 MB result costs about 35 ms locally and leaves a 450-byte
replacement, so the expensive part of a decision is the network, not the scan.

## Transport

`node dist/cli.js benchmark 30` and `npm run bench:hooks -- 30`, 30 iterations against one
session and a 52,806-character result, test asker:

| transport | p50 | p95 | mean |
|---|---|---|---|
| local pipeline, in-process | 3.2 ms | 5.7 ms | 3.7 ms |
| command hook, one process per call | 42.2 ms | 44.8 ms | 42.2 ms |
| MCP tool call, one shared process | 2.8 ms | 3.5 ms | 3.1 ms |
| MCP server startup | 31.0 ms, once per session | | |

The persistent MCP server removes the per-call Node spawn and reuses the HTTP pool. That is
a saving of roughly 40 ms on every qualifying tool result, which is the difference between
a hook the model never notices and one that adds up over a long session.

## Jev network latency

`node dist/cli.js benchmark 30 --live` adds one real reachability request and reports it
separately, because network time is not local cost. One measured request: 630 ms.
Earlier live runs of the decision path recorded 267 to 1296 ms per call. The hook deadline
is 5 s and the prompt guard gets 3.5 s, so a slow answer fails open rather than stalling.

## What keeps memory bounded

- The size gate is checked before the key lookup, so a small result costs one estimate.
- Redaction, sampling, hashing and token estimation are single linear passes with no copies
  of the full text beyond the ones the API requires.
- The sampler keeps a bounded head, the highest-signal lines from the omitted middle, and a
  bounded tail. Nothing downstream of it ever sees the whole result again.
- Chunk relevance splits a bounded sample, not the original.
- The capsule, the state, the snapshot and the cache file all have explicit character caps.
- Jev questions are batched: five questions travel in one request, and chunk questions in
  one more, instead of one request per question.

A regression test feeds a 2 MB result through the hook and asserts that the replacement
stays under 8 KB and that the call completes in bounded time. A second test asserts that a
result below the gate stays silent.

## Session state

The persistent MCP process removed the per-call Node spawn. The remaining question was
whether cache, touches, recoveries and the goal should live in memory instead of being read
from disk on every decision. `node scripts/bench-state.mjs` measures the reads an in-memory
layer would replace, on a realistic session with 40 cache entries, 10 touches and 2
recoveries:

| measurement | value |
|---|---|
| state reads per decision | 4 |
| their median cost | 0.244 ms |
| full local decision | 2.07 ms |
| share of the local decision | 11.8% |

Decision: keep the disk-backed state. A quarter of a millisecond is a rounding error next to
the 267 to 1296 ms a Jev call takes, and an in-memory layer would have to add bounded sizing,
session keying, eviction, restart recovery, corruption tolerance and a rule that the cache is
never the only source of correctness. It would also only help the MCP transport: the command
fallback runs one process per hook, so it has to read from disk regardless, and the two
transports would then behave differently. The measurement is reproducible, and the simpler
design is the one that stays correct.

## Reproducing

```bash
npm run build
node scripts/bench-stages.mjs 200000 5
node dist/cli.js benchmark 30
npm run bench:hooks -- 30
node dist/cli.js benchmark 30 --live   # one real request
```

All but the last command are offline and cost nothing.
