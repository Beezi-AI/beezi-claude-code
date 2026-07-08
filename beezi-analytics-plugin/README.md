# beezi-analytics-plugin

A Claude Code plugin that hooks into session lifecycle events (SessionStart, PostToolUse, SessionEnd) to collect and report token usage analytics for Beezi task branches. On session end it ships a summary — tokens consumed, tool calls made, and branch context — to the Beezi analytics endpoint so teams can track AI-assisted development cost and throughput per task.

## Install

```
/plugin marketplace add <github-username>/<repo-name>
# and
/plugin install beezi@beezi
```

## Commands

- `/beezi:login` — link this machine (browser device flow); stores the token in the OS secret store, or a restricted-permission file when no store is available (see Credential storage below).
- `/beezi:me` — show this machine's link status (account, device count, last session).
- `/beezi:track` — manually save analytics for the **current** task branch. Fails with an error if the branch is not a `.../task-…` branch or the repo is not connected; on success prints `analytics saved for task-…`.

Analytics are otherwise tracked automatically via the session lifecycle hooks — `/beezi:track` is only needed to force a save mid-session.

## Dependencies

**Zero dependencies** — the plugin runs on Node built-ins alone (`package.json` declares no
deps), so `/plugin install` works immediately with nothing to `npm install` or vendor, on
every platform.

## Credential storage

The `/beezi:login` token is stored in the OS secret store via its built-in CLI — no native
module, no `npm install`:

- **macOS** — the login keychain (`security add/find/delete-generic-password`).
- **Linux** — the Secret Service / libsecret (`secret-tool`) when installed; otherwise the file fallback.
- **Windows** — DPAPI (user-bound encryption via PowerShell); the ciphertext is kept in the file. (Credential Manager can store but not return a secret from the CLI, so DPAPI is used instead.)
- **Fallback** — a `0600` file at `BEEZI_HOME/credentials.json` (default `~/.beezi/`) whenever no store is available.

## Development

```bash
npm test   # runs node --test (Node built-in runner, no jest); no install/build step
```

- ESM only: all source files are `.mjs`; `package.json` sets `"type": "module"`.
- No build step, no dependencies.

## Limitations & server contract

- **Idempotency key**: the `segmentId` field (`"<session_id>:<fromLine>-<toLine>"`) is an idempotency key. Overlapping PostToolUse and SessionEnd hook processes can deliver the same segment more than once; the server MUST upsert on `segmentId`, not sum-on-insert.
- **Transcript compaction**: if a transcript file is rewritten shorter than the persisted cursor (e.g. history compaction on the same session id), leading lines of the rewritten transcript may be skipped. This is a known limitation — no mitigation is applied client-side.
