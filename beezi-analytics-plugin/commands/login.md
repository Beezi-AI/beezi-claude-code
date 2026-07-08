---
description: Link this machine to Beezi analytics (browser device flow)
allowed-tools: Bash(node:*)
---

Do NOT read, open, or inspect any files yourself. Run only the given commands.

Step 1 — get the code and open the browser (returns quickly):

`node ${CLAUDE_PLUGIN_ROOT}/scripts/login.mjs start`

After step 1 finishes, show the user its full output — especially the
`Verification code: XXXX-XXXX` line — so they can confirm it matches the code on
the Beezi page. If that output says the machine is **already linked**, stop here
and tell the user; do NOT run step 2.

Step 2 — wait for approval and store the token (blocks until approved):

`node ${CLAUDE_PLUGIN_ROOT}/scripts/login.mjs wait`

Report success or the error message. The analytics token is never printed — do
not echo it.

Step 3 — capture the subscription plan for analytics (only if Step 2 linked
successfully; skip if the machine was already linked). Run EXACTLY this one
command, unmodified:

`node ${CLAUDE_PLUGIN_ROOT}/scripts/billing-capture.mjs --from-claude --via login`

It reads only the non-secret account info from `~/.claude.json`. Report its
one-line summary. If it says nothing was captured, skip silently — the link itself
already succeeded.
