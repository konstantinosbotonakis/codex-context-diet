# Packaging

Context Diet ships two manifests on purpose. The portable Agent Plugins
manifest is authoritative; the legacy Codex overlay is generated from it for
builds that predate the portable format.

## Layout

```text
plugin.json                    portable manifest, authoritative
mcp.json                       portable MCP config, authoritative
.codex-plugin/plugin.json      legacy overlay, generated
.mcp.json                      legacy MCP config, generated
hooks/hooks.json               command hook wiring selected by the plugin manifest
hooks/hooks.command.json       command-hook parity/fallback file
hooks/hooks.mcp.json           optional MCP-tool hook wiring
skills/                        skills, discovered from the folder
schemas/agent-plugins/1.0.0/   vendored official schemas the validator uses
dist/                          committed build output
```

`plugin.json` and `mcp.json` are the only files a maintainer edits. Everything
else in the list is either generated or discovered by convention. `npm run
sync:manifest` rewrites the two legacy files, and `npm run validate:plugin`
fails when they drift from the portable source.

## What the host actually does

Measured against Codex Desktop 0.155.0 with throwaway `CODEX_HOME` roots:

| layout | result |
|---|---|
| portable only | installs; version read from `plugin.json`; MCP server registers from `mcp.json` |
| legacy only | installs; MCP server registers from `.mcp.json` |
| both | installs; portable version wins; portable `mcp.json` wins over `.mcp.json`; no duplicate servers |

Two consequences shaped the layout. First, the portable MCP schema requires a
`type` on every server; without it the host logs `ignoring invalid executor
plugin MCP server` and silently skips the server. Second, because both files
can define the same server, they are generated from one source so the choice
between them cannot change behaviour.

The legacy overlay stays because the hook wiring is keyed to the plugin root
and its `hooks/hooks.json` path, and because a Codex build that predates the
portable manifest still reads the overlay. Removing it would trade a working
installation for a smaller file tree.

## The one documented deviation

The `plugin-creator` skill shipped with Codex validates `.codex-plugin/plugin.json`
and rejects `$schema` and `extensions` as unsupported top-level fields. That is
the legacy contract. The 0.155.0 runtime itself validates the portable manifest
against `https://agent-plugins.org/schemas/1.0.0/plugin.schema.json`, reads the
`com.openai` extension namespace in `core-plugins/src/agent_plugin_manifest.rs`,
and ignores unknown top-level fields with a log line.

`npm run validate:plugin` therefore checks both contracts: the portable files
against the vendored official schemas, and the legacy overlay against the
ingestion rules the skill enforces. A file that satisfies only one of them
fails the run.

## Clean-install procedure

```bash
node scripts/install-check.mjs
```

That copies the working tree into a temporary marketplace, installs it into a
throwaway `CODEX_HOME`, and asserts that the plugin is enabled, that its MCP
server is registered, and that the installed copy carries both manifests and
the hooks. It never touches the real Codex home, and because the cache is
fresh, a globally cached copy cannot make it pass. It is not part of CI:
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

1. Edit `plugin.json` or `mcp.json`.
2. Run `npm run sync:manifest`.
3. Run `npm run validate:plugin`.
4. Run `node scripts/install-check.mjs` before a release.

Version changes touch `package.json`, `plugin.json` and the generated
`.codex-plugin/plugin.json`; the validator fails when they disagree.
