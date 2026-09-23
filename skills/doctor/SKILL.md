---
name: doctor
description: Diagnose why Context Diet is not acting on a session. Use when the user says the plugin is not working, Jev is never used, results are not being replaced, the stats are empty, or asks for a health check of the install.
---

# Diagnose Context Diet

Start with the offline health check, then follow the one line that is not `ok`:

```bash
node dist/cli.js doctor
```

It probes the Node version, the config file, the Jev key, the data directory, the session
caches, the log, the three version carriers, the hook wiring, the built entry points and a
live MCP stdio handshake. Nothing leaves the machine. Exit code 1 means a hard failure.

## Following the result

| finding | next step |
|---|---|
| `config` fails | the file exists but does not parse, so defaults are in use and edits are ignored. Fix the JSON or move the file aside |
| `jev key` warns | Jev never runs. Set `TYPESAFE_API_KEY`, write `~/.typesafe_key`, or use the `apiKey` config field. Results stay in full and the session says so once an hour |
| `data directory` fails | nothing can be written, so decisions still happen but nothing is recorded and stats stay empty |
| `build` fails | `dist/` is missing an entry point the hooks reference. Run `npm run build` and reinstall or re-copy the plugin |
| `mcp` fails | direct MCP tools and the optional MCP hooks are unavailable; the default command hooks can still run |
| `hooks` fails | the hook file is unreadable, which usually means a broken install |

## When everything is `ok` but nothing happens

- Confirm the hooks are trusted in `/hooks`. Codex skips plugin hooks until the current
  definition is reviewed, and that is the most common cause.
- Most tool results sit below `minTokens` and the first result of every session is always kept,
  so `node dist/cli.js stats` should show `results seen` far above `results judged`.
- `observe` mode and `dryRun: true` record decisions and replace nothing. Check
  `node dist/cli.js status`.
- The cost, guard and recovery rows need `debug: true` in the config before they appear.
