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
node dist/cli.js provider set laya --subfolder typed-decisions --model convaiinnovations/laya
```

`provider set` writes the plugin config, so the hooks pick it up on their next call.

## Local setup

```bash
node dist/cli.js setup --provider laya --install   # creates the venv and installs the SDK
node dist/cli.js provider warm                     # loads the checkpoint once (about 25 s)
node dist/cli.js test                              # one real request through the local model
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

## Measured comparison

All rows measured on 2026-09-19 on one machine (macOS arm64, Node 24.11.1, Python 3.13, MPS),
against the same 112-case labelled corpus, one request per case. Jev numbers are the published
live run in [evals/jev-1.13-2026-09-19.md](evals/jev-1.13-2026-09-19.md).

| provider | checkpoint | correct | false drops | false keeps | replacement rate | p50 | p95 | cost |
|---|---|---|---|---|---|---|---|---|
| TypeSafe Jev | jev-1.13.0 | 91/112 | 6 | 15 | 26.8% | 281 ms | 411 ms | $0.005435 |
| Laya | multilingual (mmBERT, 100+ languages) | 73/112 | 0 | 39 | 0.0% | 75 ms | 251 ms | $0 |
| Laya | typed-decisions | 73/112 | 0 | 39 | 0.0% | 175 ms | 478 ms | $0 |
| Laya | english (ModernBERT) | 73/112 | 0 | 39 | 0.0% | 108 ms | 180 ms | $0 |

How to read this table:

- With Laya the decision is **always keep** under the shipped thresholds, so `correct` is exactly
  the 73 cases labelled keep and the replacement rate is zero. Zero false drops because nothing
  is dropped at all.
- Threshold fitting did not change that. `node scripts/calibrate-laya.mjs` searches keep
  0.50 to 0.96 against drop 0.04 to 0.49 with the same policy code; no pair drops anything,
  because Laya's `replaceable` head reads almost every result as non-reproducible, which keeps
  it through the irreplaceable branch.
- A direct probe agrees. Asked a single choice question (keep or replace), the multilingual
  checkpoint answered keep for all 16 sampled cases with both boolean heads saturated at 1.0;
  the typed-decisions checkpoint answered replace for 11 of 16, including error logs, which is
  the dangerous direction.
- Latency is not the problem: local answers are 75 to 175 ms once the model is loaded, against
  281 ms of network time for Jev. The 23 to 37 second load is a one-off per daemon start.

Laya's own model card says the same thing: the base checkpoints score around 0.35 zero-shot on
their typed-decisions benchmark and are meant to be fine-tuned or temperature-calibrated for a
domain. Treat this provider as the plug for a model you have specialised, not as a drop-in
replacement for Jev's judgement today. The plugin keeps Jev as the default for that reason.

## Calibrating a local model

```bash
node dist/cli.js provider set laya --subfolder multilingual
node dist/cli.js provider warm
node scripts/calibrate-laya.mjs            # report the best thresholds on the corpus
node scripts/calibrate-laya.mjs --write    # save them to the config
```

The script asks the corpus through the configured provider, then scores every keep/drop
threshold pair with the same decision code the hooks use, preferring fewer false drops on a tie.
After fine-tuning a checkpoint, this is how you re-fit the thresholds to it.

## What leaves the machine

With `provider: laya`, nothing does. The state is built and redacted exactly as before, then
handed to a local process. There is no key to configure and no metered cost; `stats` reports the
estimated cost as zero because the tokens were computed on your own hardware.

