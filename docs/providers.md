# Decision model providers

Context Diet asks typed questions (a boolean, a choice, or a score) and lets deterministic code
decide. That contract is small, so the model behind it is replaceable. Two providers ship:

| provider | where it runs | key | cost |
|---|---|---|---|
| `jev` (default) | TypeSafe's hosted API | needs a TypeSafe key | $0.042 per million input tokens |
| `laya` | a local open checkpoint (Apache 2.0, ConvAI Innovations) | none | $0 |

## Switching

```bash
node dist/cli.js provider                          # what is configured, and its live state
node dist/cli.js provider set laya                 # use the local model
node dist/cli.js provider set jev                  # back to the hosted model
node dist/cli.js provider set laya --subfolder multilingual
```

`provider set` writes the plugin config, so the hooks pick it up on their next call.

## Checkpoints

`convaiinnovations/laya` holds three checkpoints in one repository:

| subfolder | what it is | shipped head |
|---|---|---|
| empty string, the repository root | the English ModernBERT checkpoint, the smallest and fastest | `calibration/laya-head.json` |
| `multilingual` | mmBERT, the 100+ language checkpoint | `calibration/laya-head-multilingual.json` |
| `typed-decisions` | the large typed-decision checkpoint | none |

The root checkpoint is the English one. An earlier version of this page listed an `english`
subfolder. That path does not exist in the repository, and the numbers in that row were measured
through the error path. `provider set laya --subfolder ''` selects the root.

A head is a small probe trained on this machine, described below. When no head exists for the
configured checkpoint the plugin reads the checkpoint's own answers, and those currently keep
every result, so `typed-decisions` behaves as a pass-through.

## Local setup

```bash
node dist/cli.js setup --provider laya --install   # creates the venv and installs the SDK
node dist/cli.js provider warm                     # loads the checkpoint once (about 25 s)
node dist/cli.js test                              # warms, then one real request through the local model
```

Without `--install`, `setup` prints the steps instead of running them:

1. `uv venv --python 3.13 <PLUGIN_DATA>/providers/laya/venv`
2. `uv pip install --python <that venv>/bin/python laya`
3. `node dist/cli.js provider set laya --subfolder multilingual`
4. `node dist/cli.js provider warm`

Requirements: Python 3.9 to 3.13 (torch has no 3.14 wheel yet), about 1 GB per checkpoint, and a
first run that downloads the weights from Hugging Face. `provider warm` starts a worker process
that holds the model and answers over a unix socket; the first call starts it too, so warming is
optional. Every failure keeps the tool result: an unavailable local model is a lost optimisation,
never a lost session.

Head mode is on by default. `node dist/cli.js provider` prints the head file in use, and
`layaHead: false` switches back to the checkpoint's own answers.

## Measured comparison

All rows measured on one machine (macOS arm64, Node 24.11.1, Python 3.13, MPS) against the same
112-case labelled corpus, one request per case. The Jev row is the published live run in
[evals/jev-1.13-2026-09-19.md](evals/jev-1.13-2026-09-19.md). The head rows were measured on
2026-09-20.

| provider | checkpoint | correct | false drops | replacement rate | p50 | p95 | cost |
|---|---|---|---|---|---|---|---|
| TypeSafe Jev | jev-1.13.0 | 91/112 | 6 | 26.8% | 281 ms | 411 ms | $0.005435 |
| Laya, stock answers | root (English) | 73/112 | 0 | 0.0% | 108 ms | 180 ms | $0 |
| Laya, stock answers | multilingual | 73/112 | 0 | 0.0% | 75 ms | 251 ms | $0 |
| Laya, stock answers | typed-decisions | 73/112 | 0 | 0.0% | 175 ms | 478 ms | $0 |
| Laya, decision head | root (English) | 80/112 | 2 | 9.8% | 28 ms | 47 ms | $0 |
| Laya, decision head | multilingual | 73/112 | 0 | 0.0% | 16 ms | 23 ms | $0 |

The Jev row was re-run on 2026-09-20 on the same machine and the same corpus through the same
code: 90 of 112 correct, 6 false drops, 16 false keeps, $0.005435, p50 285 ms. Jev's own answers
vary a little between runs; the difference is one case.

How to read this table:

- With stock answers the decision is always keep, so `correct` is exactly the 73 cases labelled
  keep. Zero false drops because nothing is dropped, not because the model is careful.
- Jev dropped 30 of the 112 cases, and 6 of those drops cost it a case the corpus expects to keep.
- The root head replaced 11 cases, and every one of them is a case Jev also drops. The two
  `false drops` are the corpus labels disagreeing with Jev, not with the head
  (`large-json-response` and `db-migration-applied`). Measured against Jev on the same cases the
  head disagrees on nothing.
- The multilingual head is the more conservative of the two. It dropped nothing on this corpus,
  and in cross-validation it recovers 12 of 88 teacher drops against the root head's 29.
- Head mode is also the fastest path measured here, because it reads the encoder once instead of
  running Laya's own question heads.

## The decision head

Laya's own heads carry almost no signal on this task. Measured over 400 real tool results,
per-question and joint threshold calibration on its answers recovered 0 of 58 teacher drops, and
a per-feature AUC diagnostic returned 0.500 for every answer. Laya's model card recommends
fine-tuning for a domain, and this matches.

The calibration that established that is `node scripts/fit-calibration.mjs`; it fits the same
probe on Laya's answers instead of on the encoder, and its reported recovery is what motivated
the encoder path.

The shipped head skips the question path. It encodes the result text with the checkpoint's own
encoder, mean-pools the last hidden state over the first 512 tokens, L2-normalises the vector,
and applies two linear probes fitted with ridge regression:

- `drop`: would the teacher replace this result
- `hazard`: is the text addressed to an agent, or does it try to change what happens next

The thresholds are the lowest score that produced no false drop in 5-fold cross-validation, so
they are conservative by construction. The head writes its verdict in the same answer shape Laya
uses, and the same deterministic policy decides.

The head is fitted for the five diet questions only, and the calibration file lists them. A
direct question outside that set, such as one asked through the judgement tools, goes to the
checkpoint's own heads instead, and the answer says which path answered: the model name carries
`+head` when the probe decided, and the plain name when the checkpoint did.

Training data: 512 real tool results, 400 mined from local Codex session logs and 112 from the
labelled corpus, each labelled by Jev as the teacher. The pipeline is in the repository:

```bash
node scripts/mine-session-results.mjs --limit 400 --out /tmp/cd-mined.json
node scripts/distill-pairs.mjs --states /tmp/cd-mined.json --out /tmp/cd-pairs/mined.json
node scripts/export-states.mjs --states /tmp/cd-mined.json --pairs /tmp/cd-pairs/mined.json --out /tmp/cd-states-mined.json
node scripts/export-states.mjs --corpus --out /tmp/cd-states-corpus.json
node scripts/export-states.mjs --merge /tmp/cd-states-mined.json,/tmp/cd-states-corpus.json --out /tmp/cd-states.json
python3 scripts/train-laya-head.py --states /tmp/cd-states.json --subfolder '' --out calibration/laya-head.json
```

`distill-pairs.mjs` needs the TypeSafe key, because Jev labels the examples. Its Laya half uses
whatever checkpoint the config selects, so run the last command once per checkpoint with the
matching `--subfolder` and `--out`.

Cross-validated on those 512 states:

| head | agreement with Jev | teacher drops recovered | false drops | hazard recall | hazard precision |
|---|---|---|---|---|---|
| root (English, 1024-dim) | 88.5% | 29 of 88 | 0 | 0.381 | 1.000 |
| multilingual (768-dim) | 85.2% | 12 of 88 | 0 | 0.515 | 1.000 |

What was tried and did not beat the shipped configuration, on the same folds and with the same
zero-false-drop rule:

| variant | teacher drops recovered |
|---|---|
| 512-token prefix, ridge, flat weights, lambda 0.01 | 29 of 88, shipped |
| 1024-token prefix | 26 |
| head and tail windows, 384+128 / 256+256 / 640+128 tokens | 11 / 24 / 21 |
| logistic regression | 1 |
| small MLP, 64 / 128 hidden units | 0 / 0 |
| sample weights scaled by result length | 22 / 14 |
| Laya's own answers, any threshold pair | 0 |

Recovery is counted against Jev, not against truth. The head learned Jev's judgement, and on
mined states it reproduces about a third of Jev's drops, which is 17.5% of the characters Jev
would have removed. The rest stay in the transcript. That is the honest scope of the local
provider: it makes the easy calls, and the default stays Jev.

## Daemon lifecycle

The worker holds one checkpoint in memory, so its identity covers the model, the subfolder and
the head file. Editing the worker, retraining a head or switching checkpoints retires the running
daemon on the next call, and a caller that gives up waiting no longer takes the daemon down with
it. A cold start still takes about 25 seconds, and a call inside that window fails open. Run
`provider warm` once after switching checkpoints if you want the first judged result to be the
real one.

## Threshold calibration for raw answers

`node scripts/calibrate-laya.mjs` searches keep and drop threshold pairs against the corpus with
the same decision code the hooks call, preferring fewer false drops on a tie, and `--write`
saves the result. Use it with a checkpoint you fine-tuned yourself, or with the head switched
off. With a shipped head the decision comes from the head's own threshold instead.

## What leaves the machine

With `provider: laya`, nothing does. The state is built and redacted exactly as before, then
handed to a local process. The head runs in that same process, on the same bytes. There is no key
to configure and no metered cost; `stats` reports the estimated cost as zero because the tokens
were computed on your own hardware.
