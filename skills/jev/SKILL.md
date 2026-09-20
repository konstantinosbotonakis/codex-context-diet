---
name: jev
description: Use the configured System One provider (TypeSafe's Jev by default, or a local checkpoint) for calibrated judgements instead of a reasoning model. Trigger when a task needs a yes/no probability, a pick from named options, a score along ordered levels, or several such judgements over one bounded piece of text.
---

# System One judgements

The provider answers typed questions about a state and returns probabilities, not prose. It is
served by the Context Diet MCP server, so the tools appear as `mcp__context-diet__jev_boolean`,
`mcp__context-diet__jev_choice`, `mcp__context-diet__jev_score` and
`mcp__context-diet__jev_ask`. They route to the configured provider, Jev by default or a local
checkpoint when `provider: laya` is set, and every response names the model that answered.

## Delegation policy

Complex reasoning stays with Codex. Classification, filtering, routing, ranking, and simple
judgements go to the provider.

- Delegate: which bucket does this belong to, is this relevant, which handler should run, which
  candidate is the intended one, is this claim supported by its evidence, how severe or noisy is
  this.
- Keep in Codex: planning across several steps, code synthesis, anything that has to hold a long
  chain of thought, and anything with an exact answer code can compute.
- Say which steps used it. When a task mixed both, name the steps that were model judgements, in
  the answer or in the note left behind, so a reader can tell what a System One model decided and
  what code decided.

## When to use which tool

- `jev_boolean` for one yes/no judgement: does this failure originate in the database layer, would this prompt change a live system, is this changelog user-visible.
- `jev_choice` for a category with named options: frontend, backend, database, infrastructure. The response carries the full probability distribution, so a low-confidence split is visible.
- `jev_score` for a graded judgement over ordered levels: severity from calm to angry, noise from quiet to unusable.
- `jev_ask` for several independent judgements over one state in a single request. The questions run in parallel and cannot see one another's answers, so state every speculative premise explicitly and let code consume the answers it needs.

## Design the questions

- Ask one narrow, coherent judgement per question. Split dimensions that are useful on their own,
  and keep the relationship being judged intact.
- Put the whole meaning in the question text. Ids exist for code, so never let an id carry meaning
  the question does not.
- Give the question enough state to be answerable: the text, the identities, the policy, the
  current facts. Prefer named JSON fields when the state has several parts.
- For a choice, build the option list in code and include a no-match option when nothing may fit.
  The model cannot pick a value that was never offered, so check coverage before trusting a choice.
- For a score, make each level describe a concrete situation that stands on its own. Levels that
  only make sense next to each other produce noise.
- When several labels may apply at once, ask one boolean per label instead of forcing one choice.

## Rules of thumb

- Ask the questions that share a state together, in one `jev_ask` call. A second request is for
  when an answer decides what evidence to fetch or what the next options are.
- Keep the state bounded. The server rejects anything over 120,000 characters, so sample long logs first.
- Treat probabilities as evidence, not as a verdict. Keep the deterministic decision in your own code, and keep the uncertain band on the safe side for the task.
- Prefer these tools over a reasoning model when the judgement is narrow, the options are enumerable, and a probability is more useful than an explanation.
- Do not send secrets. The server redacts common shapes before the request, but do not rely on that as the only line of defence.

## When deterministic code should decide instead

Reach for code, not the model, whenever a formula, a parser or a comparison answers the question:

- arithmetic, counts, sums and unit conversions
- string equality, containment, sorting, deduplication and version comparison
- anything with an exact answer that a test could assert
- policy decisions such as thresholds, allow and deny lists, or which branch to take

The provider returns a probability about meaning. Asking it whether two strings are equal produces
a number that looks like calibration and is theatre, and a wrong number is worse than one line
of code.

## Reading the answer

`jev_boolean` returns a probability and a boolean at 0.5. `jev_choice` and `jev_score` return
the answer plus `confidence` and the full `probabilities` distribution. Habits that keep the
results honest:

- A probability near 0.5 means the two readings are about equally likely. It does not mean medium
  intensity, and it is not permission to act.
- `confidence` summarizes how concentrated the distribution is, not whether the judgement is
  right, and not whether the workflow around it is correct.
- Prefer the distribution over the headline. A choice at 0.4 against 0.35 is a split, not a
  verdict, and the split usually means the options overlap or the state is thin.
- Keep every threshold in your own code, and calibrate it on representative cases of your own.
  The model supplies the score; the caller decides what the score means, and the uncertain band
  should resolve to the safe side for the task.

Confidence is the model's self-report, not a guarantee. It tends to be high on questions that
are easier than they look. When a wrong answer is expensive, run the same question twice with
the criteria reworded and treat a disagreement as uncertainty.

## Cost and latency

One call carries roughly 600 to 700 input tokens and costs about $0.00003 at the published
$0.042 per million input price. A live call takes hundreds of milliseconds. Batch questions
that share a state, keep the state bounded, and leave the deterministic path for everything
that does not need a judgement about meaning. A local checkpoint answers the same questions
with no key and no metered cost; see [docs/providers.md](../../docs/providers.md).

