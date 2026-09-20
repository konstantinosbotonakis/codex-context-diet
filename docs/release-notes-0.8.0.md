# Context Diet 0.8.0

0.8.0 makes the judgement tools worth reaching for. A new batch tool asks several questions over
one state in a single request, every replacement now says which model judged it, and two bugs that
only live testing could find are fixed.

## What is new

- **`jev_ask`, a batch judgement tool.** Up to eight independent questions over one state in one
  request: booleans, choices and scores. Classification, filtering and routing want several small
  judgements over the same text, and they now cost one request instead of one each. The questions
  run in parallel and cannot see one another, so the tool asks for every premise explicitly.
- **Every decision names the model that made it.** A replacement note now ends with "Judged by
  jev-1.13.0." or "Judged by laya/convaiinnovations/laya+head.", the injection warning carries the
  same, and the decision log and the session cache record it. Deterministic decisions, such as a
  duplicate, the first result of a session, or a missing key, stay unlabelled because no model made
  them.
- **The judgement tools follow the configured provider.** They always routed through it; now their
  descriptions say so, they answer from the local checkpoint when `provider: laya` is set, and
  every response names the model that answered.
- **Delegation guidance in the skills.** `$codex-context-diet:jev` now states what belongs to a
  System One model (classification, filtering, routing, ranking, simple judgements) and what stays
  in Codex (planning, code synthesis, long chains of thought), plus the question design rules: one
  narrow judgement per question, ids are for code and not for meaning, a no-match option in a
  choice, score levels that stand on their own, and thresholds calibrated on your own data.

## Two bugs that live testing found

- **Every live Jev score answer was rejected.** Jev keys a score distribution by level index and
  sends the labels in a `legend` beside it. The tools compared those index keys to the supplied
  labels, so `jev_score` failed on every real call since it shipped. Tests never caught it because
  the fake asker returns label keys. The parser now re-keys from the legend in one place, and both
  the single tool and the batch tool return label-keyed probabilities.
- **The Laya head answered questions it was never fitted for.** With head mode on, any question id
  outside the five diet questions came back with the diet verdicts. The calibration files now list
  the questions the probe covers, the worker uses the head only for those, and anything else goes
  to the checkpoint's own heads. The model name says which path answered: `+head` when the probe
  decided, the plain name when the checkpoint did.

## Measured on the release machine

2026-09-20, macOS arm64, MPS, against the live services and the local checkpoint.

| check | result |
|---|---|
| `jev_ask`, three questions over one state, live Jev | one request, 417 input tokens, `model: jev-1.13.0` |
| `jev_score`, live Jev | `{"score":0.02,"probabilities":{"quiet":0.98,"chatty":0.02,"unusable":0}}` |
| `jev_ask` through the local checkpoint | `model: laya/convaiinnovations/laya`, the checkpoint's own answers |
| the diet questions through the local head | `model: laya/convaiinnovations/laya+head` |
| full hook, 19,389-character Bash result, local | 157 ms, "Judged by laya/convaiinnovations/laya+head" |
| full hook, same result, Jev | 1,883 ms, "Judged by jev-1.13.0" |
| test suite | 317 passing in 32 files |

## Upgrading

Nothing to migrate. The new tool and the attribution are additive, and the parser fix changes only
answers that were previously rejected outright.

