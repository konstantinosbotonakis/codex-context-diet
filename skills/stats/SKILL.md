---
name: stats
description: Show Context Diet usage statistics for this machine. Use when the user asks how much Context Diet saved, how many results were replaced, whether Jev is being used, or for plugin usage numbers for today, the last 7 days, or the last 30 days.
---

# Context Diet statistics

Run the stats command from the installed copy and show the table:

```bash
d=$(ls -d ~/.codex/plugins/cache/*/codex-context-diet/*/ | head -1)
node "$d/dist/cli.js" stats
```

Flags:

- `--json` prints the same numbers as JSON.
- `--all` widens the read to every `codex-context-diet-*` store under `~/.codex/plugins/data`.
- From a clone of the repository, `node dist/cli.js stats` is the same command.

Notes:

- The table covers today, the last 7 days and the last 30 days.
- Jev calls, prompt guard runs and key warnings need `debug: true` in the config. Without it,
  the table says so instead of printing zeros.
- Jev input tokens and the estimated cost come from the usage the API reports on every call,
  priced at `pricePerMillionInputTokens`, 0.042 USD per million input tokens by default.
- The counts never include tool output, prompts or commands.
