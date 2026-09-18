---
name: update
description: Update the Context Diet plugin to the latest published version. Use when the user asks to update or upgrade Context Diet, to check whether a newer version exists, or when a fix or setting is missing from their installed copy.
---

# Update Context Diet

The plugin installs from a git marketplace, so updating is two commands. Nothing in your
configuration or cache is touched: those live in `$PLUGIN_DATA`, which is separate from the
installed copy.

## 1. Find both versions

Installed version:

```bash
for d in ~/.codex/plugins/cache/*/codex-context-diet/*/; do
  echo "$d -> $(node -p "require('$d/plugin.json').version")"
done
```

Latest published version:

```bash
curl -s https://raw.githubusercontent.com/konstantinosbotonakis/codex-context-diet/main/plugin.json | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).version"
```

If they match, say so and stop. Do not reinstall for no reason.

## 2. Update

```bash
codex plugin marketplace upgrade context-diet
codex plugin remove codex-context-diet@context-diet
codex plugin add codex-context-diet@context-diet
```

The remove and add are both required. Upgrading the marketplace refreshes the clone it
points at, and the installed copy is taken from that clone only when the plugin is added
again.

## 3. Confirm

Re-run the version check from step 1 and report the before and after. Then mention:

- Hooks may need trusting again in `/hooks` if this release changed `hooks/hooks.json`. Codex
  skips plugin hooks until they are trusted, so an untrusted hook looks like a plugin that
  does nothing.
- `~/.codex/plugins/data/codex-context-diet-context-diet/` holds the config, the decision log and the
  per-session caches. All of it survives an update.
- `node dist/cli.js status` inside the installed copy prints the config path, the key source and
  the cached session count if you need to confirm the install is live.

## If it does not update

- `codex plugin list` should show one `codex-context-diet@context-diet` entry. Two entries, or one
  from a marketplace that no longer exists, means an older install is still enabled and its
  hooks are running alongside the new one. Remove the stale one with
  `codex plugin remove codex-context-diet@<that-marketplace>`.
- A version that will not move usually means the marketplace clone is stale. Remove the
  marketplace and add it again: `codex plugin marketplace remove context-diet` then
  `codex plugin marketplace add konstantinosbotonakis/codex-context-diet`.

