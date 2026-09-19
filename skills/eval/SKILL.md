---
name: eval
description: Run the Context Diet decision corpus and report false drops, replacement rate, compression and cost. Use when the user asks whether Context Diet decisions are safe, wants evaluation numbers, or has changed a diet threshold, a prompt or a capsule rule.
---

# Evaluate Context Diet decisions

Two evaluation surfaces ship with the plugin. Both are offline by default.

```bash
node dist/cli.js eval              # the 26-case decision corpus, no network
node dist/cli.js eval --live       # the same corpus against the real model
node scripts/eval-prompts.mjs      # the labelled prompt-guard set, no network
node scripts/eval-prompts.mjs --live
```

## Reading the report

- `false drops` must be zero. A false drop is a result the session still needed, replaced
  anyway, and it is the only unrecoverable failure the plugin can cause. Offline mode exits 1
  on any false drop, and CI fails with it.
- `replacement rate` is the share of judged results that were replaced. A rate near zero means
  the corpus, not the plugin, is the interesting question.
- `compression` shows mean and median characters removed. The median matters because one huge
  log can carry the mean on its own.
- `Jev calls`, `tokens`, `estimated cost` and `latency` are reported separately, because
  context tokens and Jev tokens are different resources.

## Adding a fixture

`evals/cases.json` holds one entry per case: `id`, `category`, `goal`, `tool`, `input`, a
`fixture` file under `evals/fixtures/`, `expectedAction` (`keep` or `drop`), a short `reason`,
and the `signals` a correct Jev answer would give. Add a case whenever a real incorrect
decision turns up, then run `node dist/cli.js eval` and confirm the false-drop count is still
zero. Offline mode proves the deterministic pipeline; `--live` shows what the model does with
the same cases and costs a few cents.

After changing a threshold, a question wording or a capsule rule, run the corpus before and
after and compare the two reports rather than the raw score.

