---
name: jev
description: Use Jev, TypeSafe's System One model, for one calibrated judgement instead of a reasoning model. Trigger when a task needs a yes/no probability, a pick from named options, or a score along ordered levels over a bounded piece of text.
---

# Jev primitives

Jev answers typed questions about a state and returns probabilities, not prose. It is served by the Context Diet MCP server, so the tools appear as `mcp__context-diet__jev_boolean`,
`mcp__context-diet__jev_choice` and `mcp__context-diet__jev_score`.

## When to use it

- `jev_boolean` for one yes/no judgement: does this failure originate in the database layer, would this prompt change a live system, is this changelog user-visible.
- `jev_choice` for a category with named options: frontend, backend, database, infrastructure. The response carries the full probability distribution, so a low-confidence split is visible.
- `jev_score` for a graded judgement over ordered levels: severity from calm to angry, noise from quiet to unusable.

## Rules of thumb

- Send one question per call. Batch only when the questions share the same state and one request being cheaper matters.
- Keep the state bounded. The server rejects anything over 120,000 characters, so sample long logs first.
- Treat probabilities as evidence, not as a verdict. Keep the deterministic decision in your own code, and keep the uncertain band on the safe side for the task.
- Prefer these tools over a reasoning model when the judgement is narrow, the options are enumerable, and a probability is more useful than an explanation.
- Do not send secrets. The server redacts common shapes before the request, but do not rely on that as the only line of defence.

## When deterministic code should decide instead

Reach for code, not Jev, whenever a formula, a parser or a comparison answers the question:

- arithmetic, counts, sums and unit conversions
- string equality, containment, sorting, deduplication and version comparison
- anything with an exact answer that a test could assert
- policy decisions such as thresholds, allow and deny lists, or which branch to take

Jev returns a probability about meaning. Asking it whether two strings are equal produces a
number that looks like calibration and is theatre, and a wrong number is worse than one line
of code.

## Reading the answer

`jev_boolean` returns a probability and a boolean at 0.5. `jev_choice` and `jev_score` return
the answer plus `confidence` and the full `probabilities` distribution. Two habits keep the
results honest:

- Prefer the distribution over the headline. A choice at 0.4 against 0.35 is a split, not a
  verdict, and the split usually means the options overlap or the state is thin.
- Keep every threshold in your own code. Jev supplies the score; the caller decides what the
  score means, and the uncertain band should resolve to the safe side for the task.

Confidence is the model's self-report, not a guarantee. It tends to be high on questions that
are easier than they look. When a wrong answer is expensive, run the same question twice with
the criteria reworded and treat a disagreement as uncertainty.

## Cost and latency

One call carries roughly 600 to 700 input tokens and costs about $0.00003 at the published
$0.042 per million input price. A live call takes hundreds of milliseconds. Batch questions
that share a state, keep the state bounded, and leave the deterministic path for everything
that does not need a judgement about meaning.
