# Packaging

Context Diet keeps the portable Agent Plugins manifest as its source, but
installs a legacy-shaped root manifest for Codex. In the Codex builds tested
below, a portable root manifest registers the MCP server but hides every
plugin lifecycle hook. The two Codex manifests are generated from the portable
source so their metadata cannot drift.

## Layout

```text
plugin.portable.json           portable manifest source, not loaded by Codex
plugin.json                    Codex-compatible root manifest, generated
mcp.json                       portable MCP config, authoritative
.codex-plugin/plugin.json      Codex compatibility manifest, generated
.mcp.json                      legacy MCP config, generated
hooks/hooks.json               command hook wiring selected by the plugin manifest
hooks/hooks.command.json       command-hook parity/fallback file
hooks/hooks.mcp.json           optional MCP-tool hook wiring
skills/                        skills, discovered from the folder
schemas/agent-plugins/1.0.0/   vendored official schemas the validator uses
dist/                          committed build output
```

`plugin.portable.json` and `mcp.json` are the manifest sources a maintainer
edits. `npm run sync:manifest` writes `plugin.json`,
`.codex-plugin/plugin.json`, and `.mcp.json`; `npm run validate:plugin`
fails when those generated files drift.

## What the host actually does

Measured with throwaway `CODEX_HOME` roots against Codex CLI 0.153.4 and
the ChatGPT app's Codex 0.155.0-alpha.9.2:

| layout | result |
|---|---|
| portable root `plugin.json` | installs; MCP server registers, but `hooks/list` returns zero Context Diet hooks |
| legacy-shaped root `plugin.json` with portable `mcp.json` | installs; MCP server registers and `hooks/list` returns all nine handlers |
| legacy-only | installs; MCP server and all nine handlers register |

The portable MCP schema requires a `type` on every server; without it the host
logs `ignoring invalid executor plugin MCP server` and skips that server.
The generated `.mcp.json` keeps the legacy fallback equivalent.

The portable root format was introduced in commit `cecaf78`. The last
recorded hook event predates that commit, and the current clean-install
check reproduces the failure. Changing the handler transport alone does
not restore hook registration while the portable root manifest is present.

## The one documented deviation

The `plugin-creator` skill shipped with Codex validates the legacy
`.codex-plugin/plugin.json` shape. `npm run validate:plugin` checks
`plugin.portable.json` and `mcp.json` against vendored portable schemas,
then checks the installed Codex manifests against the legacy contract and
their generated content.

## Clean-install procedure

```bash
node scripts/install-check.mjs
```

That copies the working tree into a temporary marketplace and installs it into
a throwaway `CODEX_HOME`. It checks that the plugin and MCP server register,
the installed manifests match, and the app-server's `hooks/list` reports all
nine lifecycle handlers. It never touches the real Codex home, and the fresh
cache prevents an older global copy from making it pass. It is not part of CI:
GitHub runners have no Codex desktop build.

The same steps by hand, with `CODEX_BIN` pointing at the Codex binary:

```bash
export CODEX_HOME=$(mktemp -d)
codex plugin marketplace add /path/to/this/checkout
codex plugin add codex-context-diet@context-diet
codex plugin list
codex mcp list
```

## Changing the manifest

1. Edit `plugin.portable.json` or `mcp.json`.
2. Run `npm run sync:manifest`.
3. Run `npm run validate:plugin`.
4. Run `node scripts/install-check.mjs` before a release.

Version changes touch `package.json`, `plugin.portable.json`, and both
generated Codex manifests; the validator fails when they disagree.
