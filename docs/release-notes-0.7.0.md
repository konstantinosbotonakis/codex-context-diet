# Context Diet 0.7.0

0.7.0 makes the decision model replaceable. Jev is still the default and still the only provider
measured to drop results accurately, but the plugin can now run entirely on a local open
checkpoint, with no key and no metered cost.

## What is new

- **Provider selection.** `node dist/cli.js provider` shows what is configured and its live
  state; `provider set laya` or `provider set jev` switches. The setting lives in the config
  file, so the hooks follow it on their next call.
- **A local provider: Laya.** ConvAI Innovations' open (Apache 2.0) non-autoregressive decision
  model speaks the same three primitives this plugin asks for (noul, choice, score), so it
  plugs in behind the same contract. It runs in a Python worker that holds the checkpoint and
  answers over a unix socket; the first call starts it, and `provider warm` preloads it.
- **Setup that does the work.** `node dist/cli.js setup --provider laya --install` creates a
  managed venv (Python 3.13 via uv) and installs the SDK. Without `--install` it prints the
  steps. `provider warm` loads the checkpoint once, about 25 seconds on Apple silicon.
- **Calibration tooling.** `node scripts/calibrate-laya.mjs` asks the corpus through the
  configured provider and fits the keep and drop thresholds with the same decision code the
  hooks use, preferring fewer false drops on a tie.
- **Doctor and stats follow the provider.** `doctor` reports the provider and whether the local
  runtime is ready; a local run reports its cost as zero.

## What the comparison measured

Same machine, same 112-case labelled corpus, one request per case, 2026-09-19:

| provider | checkpoint | correct | false drops | replacement rate | p50 | cost |
|---|---|---|---|---|---|---|
| TypeSafe Jev | jev-1.13.0 | 91/112 | 6 | 26.8% | 281 ms | $0.005435 |
| Laya | multilingual | 73/112 | 0 | 0.0% | 75 ms | $0 |
| Laya | typed-decisions | 73/112 | 0 | 0.0% | 175 ms | $0 |
| Laya | english | 73/112 | 0 | 0.0% | 108 ms | $0 |

With Laya the decision is always keep: its stock checkpoints read almost every result as
non-reproducible, and threshold fitting found no pair that drops anything. A direct probe with a
keep-or-replace choice question showed the multilingual checkpoint saturating both boolean heads
at 1.0, and the typed-decisions checkpoint choosing replace on error logs. Laya's own model card
recommends fine-tuning or temperature calibration for a domain, and that matches what was
measured here.

So: the provider is real, local, private and free, and the plugin fails open around it. The
judgement is not there yet out of the box, which is why Jev stays the default. The full table,
the setup steps and the calibration workflow are in
[docs/providers.md](providers.md).

## Upgrading

Nothing to migrate. `provider` defaults to `jev`, so an existing installation behaves exactly as
before, and every new field is optional. The Laya runtime is only downloaded if you switch and
run `setup --install`. Trust the hooks again in `/hooks` after updating.

