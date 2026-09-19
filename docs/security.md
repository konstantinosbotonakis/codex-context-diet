# Security model

Context Diet is an optimisation and semantic policy layer. It decides what a session keeps
and what it can reconstruct. That makes it worth being precise about what it is not:

- not a sandbox, and it does not restrict what any tool can do
- not a complete prompt-injection defence, and it never claims to be one
- not a secret-management system, and it does not store, rotate or broker credentials
- not an authorisation system, and it does not decide what you are allowed to run

Everything below follows from one design rule: when the plugin is uncertain, or broken, or
missing, the session must behave as if the plugin were not there.

## The local privacy boundary

Redaction and exclusion are deterministic and local. No candidate secret is ever sent to a
model to ask whether it is a secret. The rules cover provider key shapes, JWTs, PEM blocks,
bearer tokens, password assignments and connection strings, and they run before any request
and before any cache or log write. A replacement placeholder keeps the shape of the text so
the model can still judge it.

In strict mode, anything matching `neverSendPaths` and anything from a tool in
`neverSendTools` stays entirely on the machine: no Jev call, no cache entry, no replacement,
no log line carrying the content. The event log records that the exclusion happened, not
what it excluded.

The development capture (`CONTEXT_DIET_CAPTURE`) follows the same rule and is redacted by
default. Recording raw payloads needs `CONTEXT_DIET_CAPTURE_UNREDACTED=1`, and that file can
then hold secrets; it exists for fixture collection, not for normal use. The session goal
is redacted when it is captured, because it is replayed in the diet state and in the
compaction snapshot.

## What leaves the machine

One Jev request carries:

- a bounded, sampled and redacted view of the result under judgement
- the tool name, and the one-line input (also redacted)
- the recent goal, and short digests of earlier results rather than their text

Nothing else. Raw tool output is never sent in full: the sampler caps it first. Raw results
never appear in the cache beyond their configured caps, and never in the log at all.

## Injection detection is a warning, not a shield

When tool output looks addressed to an assistant, the plugin forces the result to be kept
and adds one line of developer context saying so. It does not block, does not edit the
result, and does not claim the session is now safe. Treat the warning as one more signal,
not as proof of containment. A false positive costs one line; a false negative is exactly
the situation the annotation exists to surface.

## The key

The TypeSafe key is read from `TYPESAFE_API_KEY`, then `~/.typesafe_key` (override with
`TYPESAFE_KEY_FILE`), then the `apiKey` config field. The value is never written to stdout,
stderr, the event log or the cache; only its source is reported. Keep the key file at mode
600. When the key is missing or rejected, the plugin says so once per session and every
result stays in full.

## Failure behaviour

Every hook and every MCP tool fails open: a timeout, a malformed answer, an unreadable
cache, a missing MCP server or an unwritable data directory leaves the tool result
untouched. A wrong drop is the only unrecoverable failure this plugin can cause, so the
decision policy resolves every uncertain case to keep, and recovery telemetry counts the
drops that had to be undone.

## What an attacker could still do

- A tool result could instruct the model to exfiltrate data. The plugin annotates and keeps;
  containment is the host's job, not the plugin's.
- A secret shape outside the redaction rules could reach Jev inside a sampled result.
  `neverSendPaths` and `neverSendTools` exist for the cases the rules cannot cover.
- A poisoned session cache could bias a later decision. Cache writes are bounded, read
  failures are ignored, and the digest holds no raw results.

Report security issues through the repository's issue tracker rather than a public
disclosure when the report would include a working payload.
