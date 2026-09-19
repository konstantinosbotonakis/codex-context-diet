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

