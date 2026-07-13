# Beezi — Claude Code plugin

A Claude Code **plugin marketplace** and the **`beezi` analytics plugin** it ships. The
plugin hooks into Claude Code's session lifecycle to measure how much AI-assisted work each
Beezi **task branch** consumes — tokens, tool calls, session duration, rate-limit hits — and
reports it to the Beezi analytics API so teams can see cost and throughput per task.

This repo is the marketplace source:

```
beezi-claude-code/
├── .claude-plugin/marketplace.json     # marketplace manifest (lists the plugin)
└── beezi-analytics-plugin/             # the plugin itself
    ├── .claude-plugin/plugin.json      # plugin manifest
    ├── commands/                       # slash commands (/beezi:login, :me, :track, :refresh)
    ├── hooks/hooks.json                # session-lifecycle hook wiring
    ├── scripts/                        # hook + command entrypoints (thin CLI wrappers)
    ├── lib/                            # core logic (ESM modules, unit-tested)
    └── test/                           # node --test suite
```

## How it works

The plugin has three moving parts: **hooks** that fire on Claude Code lifecycle events,
**slash commands** the user runs on demand, and a **local queue** that decouples capture
from network delivery.

### 1. Auth — device flow (`/beezi:login`)

Linking a machine uses a browser **OAuth device flow**:

1. `scripts/login.mjs start` calls `POST /auth/device/start`, prints a `Verification code:
   XXXX-XXXX`, and opens the default browser at the verification URL.
2. `scripts/login.mjs wait` polls `POST /auth/device/poll` until the user approves, then
   stores the returned token in the OS secret store.

The token is **never printed**. It is read back only to authenticate API calls.

### 2. Automatic capture — lifecycle hooks (`hooks/hooks.json`)

| Hook          | Script               | What it does                                                        |
|---------------|----------------------|--------------------------------------------------------------------|
| `SessionStart`| `session-start.mjs`  | Verify link is still valid, flush any queued reports, announce whether the repo is connected, nudge for stale subscription info. |
| `PostToolUse` (Bash) | `checkpoint.mjs`| Incrementally read new transcript lines, split them into per-branch segments, enqueue token/tool/duration stats. |
| `Stop`        | `stop.mjs`           | Checkpoint at the end of an assistant turn.                         |
| `SessionEnd`  | `report.mjs`         | Final checkpoint + flush when the session closes.                  |
| `StopFailure` | `stop-failure.mjs`   | Report rate-limit / stop-failure session errors.                  |

Each checkpoint uses a **cursor** (`~/.beezi/state/<session_id>.json`) so it only processes
transcript lines it hasn't seen — safe across resumes and compaction.

### 3. Task-branch attribution

A session's work is only tracked when it happens on a **task branch** — a branch whose name
contains a `.../task-<id>` segment (regex `TASK_BRANCH_RE = /\/(task-[a-zA-Z0-9_-]+)/`). The
checkpoint replays the git **reflog** to figure out which branch was checked out at each
moment, so multi-branch sessions bill each segment to the right task. Work on non-task
branches, or in repos with no `origin` remote / not connected to Beezi, is silently ignored.

### 4. Local queue → server (`lib/checkpoint.mjs`)

Captured segments are written as `0600` JSON files under `~/.beezi/queue/` and POSTed to
`/sessions/report`. Delivery is decoupled from capture so an offline machine never loses data:

- **2xx** → accepted, file deleted.
- **4xx** → permanently rejected (e.g. branch not linked), file dropped with the reason.
- **5xx / network error** → kept and retried on the next hook.

The `segmentId` (`"<session_id>:<fromLine>-<toLine>"`) is an **idempotency key** — the server
must upsert on it, since overlapping hooks can deliver the same segment twice.

## What it uses

- **Claude Code plugin API** — marketplace + plugin manifests, `commands/*.md` slash
  commands, `hooks/hooks.json` lifecycle hooks, `${CLAUDE_PLUGIN_ROOT}` path expansion.
- **Node.js built-ins only — zero npm dependencies.** All source is ESM (`.mjs`,
  `"type": "module"`). No build step, no `npm install` on `/plugin install`.
- **OS-native credential storage** (no native module — each via the OS's own CLI):
  - **macOS** — login keychain (`security`).
  - **Linux** — Secret Service / libsecret (`secret-tool`) when present.
  - **Windows** — DPAPI (user-bound encryption via PowerShell); ciphertext kept in the file.
  - **Fallback** — a `0600` file at `~/.beezi/credentials.json`.
- **git** — read-only shell-outs (`rev-parse`, `remote get-url`, `reflog`) to resolve the
  current branch, sanitized origin remote, and per-timestamp branch timeline.
- **Beezi REST API** — `/auth/device/*`, `/sessions/report`, `/sessions/errors`,
  `/repos/status`, `/me/claude-code/whoami`.

## How to use it

### Install

```
/plugin marketplace add <github-username>/<repo-name>
/plugin install beezi@beezi
```

### Link the machine

```
/beezi:login
```

Approve in the browser. Once linked, analytics on task branches are tracked automatically —
you don't need to run anything else.

### Commands

| Command          | Purpose                                                                          |
|------------------|----------------------------------------------------------------------------------|
| `/beezi:login`   | Link this machine via browser device flow; stores the token in the OS secret store. |
| `/beezi:me`      | Show link status — account, device count, last session.                          |
| `/beezi:track`   | Force-save analytics for the **current** task branch mid-session. Fails if the branch isn't a `.../task-…` branch or the repo isn't connected. |
| `/beezi:refresh` | Re-capture the Claude subscription/plan (non-secret account info from `~/.claude.json`) for accurate cost reporting. |

### Configuration (env vars)

| Variable         | Default                                              | Purpose                         |
|------------------|------------------------------------------------------|---------------------------------|
| `BEEZI_API_URL`  | `https://beezi-api-prod.azurewebsites.net/api`       | Beezi API base URL.             |
| `BEEZI_HOME`     | `~/.beezi`                                            | Local state root (queue, cursors, credentials, billing). |

## Privacy — what leaves the machine

Reported per segment: token counts, tool-call counts, duration, the sanitized origin remote
(credentials stripped), branch name, task id, session name (the first user prompt), and
billing source/plan. **The auth token and the contents of `~/.claude.json` secrets never
leave the machine.** Session-error reports may include the last assistant message text for
rate-limit diagnostics. All local state files are written `0600`.

## Development

```bash
cd beezi-analytics-plugin
npm test   # node --test (Node's built-in runner — no jest, no install, no build)
```

- ESM only (`.mjs`); one export per file; strict, dependency-free.
- Core logic lives in `lib/` and is unit-tested; `scripts/` are thin CLI wrappers over it.

See [`beezi-analytics-plugin/README.md`](beezi-analytics-plugin/README.md) for the plugin's
own reference (credential storage details, server contract, known limitations).
