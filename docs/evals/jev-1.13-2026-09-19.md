# Live Jev evaluation, 2026-09-19

Environment: codex-cli 0.155.0, model jev-1.13.0, macOS arm64, Node 24.11.1.
Command: `node dist/cli.js eval --live`. Corpus: `evals/cases.json`, 112 labelled cases, one
Jev request per case with the five diet questions batched into it.

Cost: 129,400 input tokens, $0.005435 at the published $0.042 per million input tokens.

## Results

| run | correct | false keeps | false drops | drop precision | keep recall | replacement rate | 95% upper bound |
|---|---|---|---|---|---|---|---|
| initial question wording | 78 | 17 | 17 | 56.4% | 76.7% | 34.8% | 21.9% |
| concrete `needs_contents` criteria | 89 | 15 | 8 | 75.0% | 89.0% | 28.6% | 12.5% |
| failure bar and redaction bar | 91 | 15 | 6 | 80.0% | 91.8% | 26.8% | 10.3% |

Final run: latency p50 281.3 ms, p95 411.2 ms, compression mean 11.3%, median 0.0%.

## What changed between the runs

1. The `needs_contents` criteria now name the keep-worthy shapes: a failure, an error, a stack
   trace, a diff, a migration, a file the work is about to change, a value the next command
   needs, or anything not already captured elsewhere in the session. That halved the false
   drops and lifted keep recall from 76.7% to 89.0%.
2. A deterministic failure bar: when the result looks like a failure (the tool reported an
   error, a bounded scan finds an error-shaped line, or redaction rewrote the text), a drop
   needs a `needs_contents` score of 0.1 or lower instead of the usual 0.25. That removed two
   more false drops and lifted drop precision to 80%.

## Known misses

The six remaining false drops, each kept in the corpus as a permanent regression fixture:

- `large-json-response`
- `api-keys-in-output`
- `private-key-block`
- `summary-only-at-tail`
- `pytest-green-with-warnings`
- `db-migration-applied`

They share a shape: the value of the result is structural rather than stated. The payload is
large, the summary sits on the last line, the interesting part was replaced by a redaction
placeholder, or the output is a schema change rather than a message.

The 15 false keeps are the cheap direction: a reproducible result (a timestamp, a version, a
clean status, a duplicate read) was kept. Those cost context, not correctness.

## How to read this

- The offline run answers "given correct signals, does the policy decide correctly?" It reports
  112/112 and is the regression test that fails CI on one false drop.
- This run answers "what does the model actually score?" It matched 91 of 112 labels that the
  maintainer wrote by hand.
- Six observed failures out of 112 is an observed rate of 5.4% with an exact one-sided 95%
  upper bound of 10.3%. A bound near 1% needs roughly 300 zero-failure cases, so no claim of a
  1% false-drop rate is supported by this sample.
- A disagreement can be a model error or a label error. The six cases above were reviewed by
  hand before being recorded as model errors.

## Reproduce

```bash
npm run build
node dist/cli.js eval          # offline policy regression, no network
node dist/cli.js eval --live   # live Jev evaluation, needs a key
```

