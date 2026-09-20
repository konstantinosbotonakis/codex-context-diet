# Context Diet 0.7.1

0.7.1 makes the local provider worth switching on. Laya's own heads keep every result, so this
release adds a small decision head, fitted on this machine against Jev as the teacher, that reads
the checkpoint's encoder instead. It also fixes two daemon faults found while measuring, and
corrects a checkpoint row that was published in 0.7.0.

## What is new

- **A decision head for the local provider.** Laya's stock heads carry no usable signal on this
  task: threshold calibration on its answers recovered 0 of 58 teacher drops, and every answer
  feature scored 0.5 AUC. The shipped head skips the question path, encodes the result text with
  the checkpoint's own encoder, and applies two ridge probes fitted against Jev, one for the drop
  decision and one for hazardous text.
- **Head files per checkpoint.** `calibration/laya-head.json` covers the English checkpoint at
  the repository root, `calibration/laya-head-multilingual.json` covers the multilingual one. A
  checkpoint with no head answers raw, and `layaHead: false` turns head mode off.
- **The daemon retires itself when the plugin changes.** The worker reports the worker and head
  file times it started with, so a plugin update or a retrained head starts a fresh process
  instead of serving stale decisions.
- **A caller that gives up no longer kills the daemon.** A hook that timed out used to take the
  worker down, and the next call paid the 25 second cold load again. The write path now survives a
  closed connection.
- **`context-diet test` warms first**, then measures one real answer, so the first call after a
  checkpoint switch is not a failed-open keep.
- **`provider` and `doctor` report the head in use.**

## The measured result

Same 112-case corpus, one request per case, 2026-09-20:

| provider | checkpoint | correct | false drops | replacement rate | p50 | p95 | cost |
|---|---|---|---|---|---|---|---|
| TypeSafe Jev | jev-1.13.0 | 91/112 | 6 | 26.8% | 281 ms | 411 ms | $0.005435 |
| Laya, stock answers | root (English) | 73/112 | 0 | 0.0% | 108 ms | 180 ms | $0 |
| Laya, decision head | root (English) | 80/112 | 2 | 9.8% | 28 ms | 47 ms | $0 |
| Laya, decision head | multilingual | 73/112 | 0 | 0.0% | 16 ms | 23 ms | $0 |

Every one of the head's 11 replacements is a result Jev also drops. The two `false drops` are
corpus labels that disagree with Jev, not with the head.

Cross-validated on 512 real tool results mined from local sessions, with Jev as the teacher:

- agreement with Jev: 88.5%
- teacher drops recovered: 29 of 88
- false drops: 0
- characters recovered: 17.5% of what Jev would have removed

Alternatives that were measured and lost: a 1024-token prefix (26 of 88), head and tail windows
(11 to 24), logistic regression (1), small MLPs (0), length-weighted samples (22 and 14), and
Laya's own answers (0).

## The correction

The 0.7.0 notes and `docs/providers.md` listed a Laya checkpoint under the subfolder `english`.
That subfolder does not exist, and the numbers in that row were measured through the error path.
The English checkpoint is the repository root, and the tables now say so.

## The honest scope

The head learned Jev's judgement, so it reproduces the easy third of it. The default stays Jev,
which is still the only provider measured to judge the whole range. Reach for the local provider
when the work must stay on the machine or no key is available, and read the recovery numbers above
as the price of that.

## Upgrading

Nothing to migrate. `layaHead` defaults to true, so the head starts working on the next call
after the update; set it to false to keep the old pass-through behaviour. `stats` and the session
cache are untouched.

