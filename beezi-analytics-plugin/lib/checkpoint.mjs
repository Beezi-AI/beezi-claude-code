import fs from 'node:fs';
import path from 'node:path';
import { computeDelta as _computeDelta } from './delta.mjs';
import { getToken as _getToken } from './credentials.mjs';
import { queueDir, stateDir } from './paths.mjs';
import { git, currentBranch, resolveOriginRemote } from './git.mjs';
import { readCheckoutEvents, buildBranchTimeline, branchAt as branchAtReflog } from './reflog.mjs';
import { resolveRepoRoot } from './repo-timeline.mjs';
import { apiBase, ENDPOINTS } from './config.mjs';
import { postJson } from './http.mjs';
import { detectBillingSource } from './billing.mjs';
import { readBillingConfig, subscriptionReportFields } from './billing-config.mjs';
import { sessionNameFrom } from './session-name.mjs';
import { readJson, writeJsonSecure } from './fs-store.mjs';

function loadState(id) {
  return readJson(path.join(stateDir(), `${id}.json`), { cursor: 0 });
}

function saveState(id, state) {
  writeJsonSecure(path.join(stateDir(), `${id}.json`), state);
}

function enqueue(payload) {
  // 0600: these payloads carry session_name (prompt text), remote, and branch.
  const filename = payload.segmentId.replace(/[:/\s]/g, '_') + '.json';
  writeJsonSecure(path.join(queueDir(), filename), payload);
}

// Returns { enqueued, flush } — flush is the flushQueue summary (or null when it never ran).
export async function runCheckpoint(input, deps = {}) {
  const { session_id, transcript_path, cwd } = input;
  const getToken = deps.getToken ?? _getToken;
  const gitImpl = deps.gitImpl ?? git;
  const computeDelta = deps.computeDelta ?? _computeDelta;
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;

  let token = null;
  try { token = await getToken(); } catch { return { enqueued: 0, flush: null }; }
  if (!token) return { enqueued: 0, flush: null };

  // Below the token gate: skip this work entirely on an unlinked machine.
  const billingSource = detectBillingSource();
  const subscriptionFields = subscriptionReportFields(billingSource, readBillingConfig());
  const sessionName = sessionNameFrom(transcript_path);

  // Memoized git shell-outs for this checkpoint: dir→root, root→remote, root→reflog/HEAD.
  const rootCache = new Map();
  const remoteCache = new Map();
  const timelineCache = new Map();

  const repoRootOf = (dir) => resolveRepoRoot(gitImpl, dir, rootCache);

  const branchOf = (root, ms) => {
    if (!root) return '(unknown)';
    let entry = timelineCache.get(root);
    if (!entry) {
      let timeline = null;
      let headBranch = '(unknown)';
      try { timeline = buildBranchTimeline(readCheckoutEvents(gitImpl, root)); } catch { /* no reflog */ }
      // Always resolve current HEAD too: it's the fallback for any line lacking a
      // timestamp even when a reflog timeline exists (otherwise those bill to '(unknown)').
      try { headBranch = currentBranch(root, gitImpl) || '(unknown)'; } catch { /* keep '(unknown)' */ }
      entry = { timeline, headBranch };
      timelineCache.set(root, entry);
    }
    return (entry.timeline && ms != null) ? branchAtReflog(entry.timeline, ms) : entry.headBranch;
  };

  const resolveRemote = (root) => {
    if (!root) return null;
    if (remoteCache.has(root)) return remoteCache.get(root);
    const r = resolveOriginRemote(gitImpl, root);
    remoteCache.set(root, r);
    return r;
  };

  const state = loadState(session_id);
  let delta;
  try {
    delta = computeDelta(transcript_path, state.cursor, { cwd, repoRootOf, branchAt: branchOf });
  } catch {
    return { enqueued: 0, flush: null };
  }
  const { nextCursor, segments } = delta;

  let enqueued = 0;
  for (const seg of segments) {
    if (seg.stats.token_total === 0 && seg.stats.duration_sec === 0) continue;
    const remote = resolveRemote(seg.repoRoot);
    if (!remote) continue;
    // A single write failure must not abort the window (which would leave the cursor
    // unadvanced and re-process everything forever) — skip that segment and continue.
    try {
      enqueue({
        segmentId: `${session_id}:${seg.fromLine}-${seg.toLine}`,
        sessionId: session_id,
        remote,
        branch: seg.branch,
        from_line: seg.fromLine,
        to_line: seg.toLine,
        billing_source: billingSource,
        ...subscriptionFields,
        session_name: sessionName,
        ...seg.stats,
      });
      enqueued += 1;
    } catch { /* keep going; the cursor still advances below */ }
  }

  if (nextCursor !== state.cursor) {
    state.cursor = nextCursor;
    try { saveState(session_id, state); } catch { /* best-effort */ }
  }

  const flush = await flushQueue(token, { fetchImpl });
  return { enqueued, flush };
}

// Returns { flushed, rejected, failed, lastError } — flushed = accepted (2xx),
// rejected = permanently declined by the server (4xx, e.g. branch not linked),
// failed = transient (5xx/network, file kept for retry).
export async function flushQueue(token, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const result = { flushed: 0, rejected: 0, failed: 0, lastError: null };

  const dir = queueDir();
  const reportUrl = `${apiBase()}${ENDPOINTS.sessionsReport}`;

  let files;
  try {
    files = fs.readdirSync(dir);
  } catch {
    return result;
  }

  for (const file of files) {
    const filePath = path.join(dir, file);
    const payload = readJson(filePath);
    if (payload == null) continue;

    try {
      const res = await postJson(reportUrl, token, payload, { fetchImpl });
      if (res.status >= 200 && res.status < 300) {
        result.flushed += 1;
        fs.unlinkSync(filePath);
      } else if (res.status < 500) {
        // Permanent rejection — drop the file, but remember why.
        result.rejected += 1;
        try {
          const body = await res.json();
          result.lastError = body?.message ?? `HTTP ${res.status}`;
        } catch {
          result.lastError = `HTTP ${res.status}`;
        }
        fs.unlinkSync(filePath);
      } else {
        result.failed += 1; // keep for retry
      }
    } catch {
      result.failed += 1; // keep file for retry on network error / throw
    }
  }

  return result;
}
