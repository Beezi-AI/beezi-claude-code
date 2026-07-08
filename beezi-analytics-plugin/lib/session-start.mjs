import fs from 'node:fs';
import path from 'node:path';
import { getToken as _getToken, deleteToken as _deleteToken } from './credentials.mjs';
import { flushQueue } from './checkpoint.mjs';
import { git as _git, resolveOriginRemote } from './git.mjs';
import { stateDir } from './paths.mjs';
import { pruneStale } from './prune.mjs';
import { apiBase, ENDPOINTS } from './config.mjs';
import { whoami } from './whoami.mjs';
import { BillingSource, detectBillingSource as _detectBillingSource } from './billing.mjs';
import { readBillingConfig as _readBillingConfig, isStale as _isStale } from './billing-config.mjs';

// Resume guard: create cursor=0 ONLY if absent; never reset an existing session's cursor.
export function initCursorIfAbsent(sessionId) {
  const dir = stateDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const p = path.join(dir, `${sessionId}.json`);
  if (!fs.existsSync(p)) fs.writeFileSync(p, JSON.stringify({ cursor: 0 }), { encoding: 'utf-8', mode: 0o600 });
}

async function announceRepo(cwd, token, fetchImpl, gitImpl) {
  const remote = resolveOriginRemote(gitImpl, cwd);
  if (!remote) return null; // not a git repo — silent
  try {
    const res = await fetchImpl(`${apiBase()}${ENDPOINTS.reposStatus}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ remote }),
    });
    if (!res.ok) return null;
    const { connected, projectName } = await res.json();
    return connected
      ? `Beezi: repo connected${projectName ? ` to "${projectName}"` : ''}. Task-branch sessions will be tracked.`
      : 'Beezi: this repo is not connected to Beezi. No analytics tracked here.';
  } catch { return null; } // offline — silent
}

// Only an explicit revocation (whoami says invalid) should nuke the token.
// Offline/unknown (null) is treated as valid so we never drop a token we can't check.
async function isTokenRevoked(token, fetchImpl) {
  const who = await whoami(token, { fetchImpl });
  return who?.valid === false;
}

// Returns an optional systemMessage string (or null). Never throws for expected failures.
export async function runSessionStart(input, deps = {}) {
  const getToken = deps.getToken ?? _getToken;
  const deleteToken = deps.deleteToken ?? _deleteToken;
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const gitImpl = deps.gitImpl ?? _git;
  const detectBillingSource = deps.detectBillingSource ?? _detectBillingSource;
  const readBillingConfig = deps.readBillingConfig ?? _readBillingConfig;
  const isStale = deps.isStale ?? _isStale;

  let token = null;
  try { token = await getToken(); } catch { token = null; }
  if (!token)
    return '⚠ Beezi: this machine is not linked — analytics are NOT being tracked. Run /beezi:login to link it.';

  if (await isTokenRevoked(token, fetchImpl)) {
    try { await deleteToken(); } catch { /* best-effort */ }
    return '⚠ Beezi: this machine’s link was revoked — analytics are NOT being tracked. Run /beezi:login to re-link.';
  }

  initCursorIfAbsent(input.session_id);
  // Independent network I/O on the per-session hot path — flush queued checkpoints
  // and probe repo status concurrently rather than serially.
  const [, systemMessage] = await Promise.all([
    flushQueue(token, { fetchImpl }),
    announceRepo(input.cwd, token, fetchImpl, gitImpl),
  ]);
  try { pruneStale(); } catch { /* best-effort */ }

  let message = systemMessage;
  if (detectBillingSource() === BillingSource.SUBSCRIPTION && isStale(readBillingConfig())) {
    const nudge = 'Beezi: subscription plan info is missing or stale — run /beezi:refresh to update it.';
    message = message ? `${message}\n${nudge}` : nudge;
  }
  return message;
}
