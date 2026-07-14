---
description: Link this machine to Beezi analytics (browser device flow)
allowed-tools: Bash(node:*), AskUserQuestion
---

Do NOT read, open, or inspect any files yourself. Run only the given commands.

Step 1 — get the code and open the browser (returns quickly):

`node ${CLAUDE_PLUGIN_ROOT}/scripts/login.mjs start`

After step 1 finishes, show the user its full output — especially the
`Verification code: XXXX-XXXX` line — so they can confirm it matches the code on
the Beezi page. If that output says the machine is **already linked**, tell the
user and do NOT run step 2 — but still continue with step 3 below, so a user
whose subscription tier changed can still refresh it.

Step 2 — wait for approval and store the token (blocks until approved):

`node ${CLAUDE_PLUGIN_ROOT}/scripts/login.mjs wait`

Report success or the error message. The analytics token is never printed — do
not echo it.

Step 3 — capture the subscription plan for analytics (run this after a
successful Step 2 link, OR when Step 1 reported the machine was already
linked). Run EXACTLY this one command, unmodified:

`node ${CLAUDE_PLUGIN_ROOT}/scripts/billing-capture.mjs --from-claude --via login`

It reads only the non-secret account info from `~/.claude.json`. Report its
one-line summary. If it could not resolve the plan, continue to Step 4.

Step 4 — ask the user their tier (ONLY when Step 3 printed
`no Claude subscription info found`, `plan=unknown`, or
`keeping the self-reported plan`; skip this step entirely when Step 3 printed
a known plan, or when its output shows `source=anthropic_api_key` or
`source=third_party` — those machines do not bill a subscription, so a tier
question does not apply).

Ask with the AskUserQuestion tool: "Which Claude subscription do you have?"
with exactly these options: "Pro", "Max 5x", "Max 20x", "Team or Enterprise".
If they pick "Team or Enterprise", ask one follow-up question with options
"Team" and "Enterprise".

Map the final answer through this table — no other values are valid:

| Answer     | value        |
| ---------- | ------------ |
| Pro        | `pro`        |
| Max 5x     | `max_5x`     |
| Max 20x    | `max_20x`    |
| Team       | `team`       |
| Enterprise | `enterprise` |

Then run EXACTLY this command, substituting only `<value>`:

`node ${CLAUDE_PLUGIN_ROOT}/scripts/billing-capture.mjs --plan <value> --via login-user`

Report its one-line summary. If the user dismisses the question or answers
something not in the table, skip the capture — the link itself already
succeeded, say so.
