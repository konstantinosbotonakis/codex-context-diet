# Installation validation

The scenarios the PRD asks for, and the evidence that each one holds. Everything
below is reproducible from a clean checkout.

| scenario | how it is verified |
|---|---|
| fresh install from a local marketplace | `node scripts/install-check.mjs` installs the working tree into a throwaway `CODEX_HOME` and asserts the plugin is enabled, the MCP server registers, and both manifests and the hooks land in the cache |
| upgrade from 0.5.x | `tests/install-scenarios.test.ts`: a 0.5-era config and a cache line written before the newer fields still decide correctly and the old entry survives |
| upgrade from 0.6.0 | `tests/install-scenarios.test.ts`: a full 0.6.0 config keeps working unchanged |
| missing TypeSafe key | `tests/install-scenarios.test.ts`: every result is kept, the session gets one warning line, the log records `key_missing`, and a second call stays silent |
| invalid key | `tests/install-scenarios.test.ts`: a 401 keeps every result, warns once and records `key_rejected` |
| MCP unavailable | `hooks/hooks.command.json` is validated by `npm run validate:plugin` (every referenced entry point must exist in `dist/`), and the command mains are exercised end to end by `tests/parity.test.ts`. Copy the file over `hooks/hooks.json` and trust the hooks again |
| command fallback parity | `tests/parity.test.ts`: the static matrix plus identical output from both transports for SessionStart and both Stop guards |
| plugin disabled | `tests/install-scenarios.test.ts` and `tests/adapter.test.ts`: no decision, no session record, no network |
| `stateSource: off` | `tests/install-scenarios.test.ts` and `tests/adapter.test.ts`: results are still judged in single-turn mode and nothing is read from or written to disk |
| strict privacy | `tests/privacy.test.ts`: excluded paths and excluded tools never reach the model, the cache or the log, and the full-surface sweep finds no seeded secret in any file |
| debug enabled | the same sweep runs with `debug: true`, so the event log is included in the check |
| live key works | `node dist/cli.js test` sends one real request and reports the model, latency, answers and usage |

## Running the whole matrix

```bash
npm ci
npm run validate:plugin && npm run typecheck && npm run build
npx vitest run
node dist/cli.js verify && node dist/cli.js eval && npm run eval:guards && npm run eval:prompts
node dist/cli.js doctor
node scripts/install-check.mjs
node dist/cli.js test          # needs a key, costs a fraction of a cent
```

GitHub CI runs the offline part of that list. `install-check` and the live
commands are local only: the runner has no Codex desktop build and no key.

