import fs from 'node:fs';
import { listSubagentTranscripts } from './subagents.mjs';
import { IDLE_GAP_SEC } from './delta.mjs';
import { apiBase, ENDPOINTS } from './config.mjs';
import { postJson } from './http.mjs';

// Work done while a plan permission mode is active is `planning`. Matched loosely (substring) so a
// schema tweak — 'plan', 'plan_mode', 'planning' — still classifies as planning instead of silently
// falling back to `working` and dropping the whole planning dimension.
const isPlanMode = (mode) => typeof mode === 'string' && mode.toLowerCase().includes('plan');

const STATE = {
  WORKING: 'working',
  PLANNING: 'planning',
  WAITING_USER: 'waiting_user',
  IDLE: 'idle',
};

// Parse a JSONL transcript into an array of records; blank/malformed lines are skipped.
function parseTranscript(transcriptPath) {
  const content = fs.readFileSync(transcriptPath, 'utf-8');
  const trimmed = content.replace(/\n+$/, '');
  if (trimmed === '') return [];
  const out = [];
  for (const raw of trimmed.split('\n')) {
    if (!raw.trim()) continue;
    try { out.push(JSON.parse(raw)); } catch { /* skip malformed */ }
  }
  return out;
}

function tsOf(line) {
  return line?.timestamp ? new Date(line.timestamp).getTime() : null;
}

// A genuine user turn-start, as opposed to a tool_result echo (Claude Code writes those as
// type:'user' too) or an injected meta line. The gap BEFORE such a line is time the agent spent
// waiting on the human.
function isRealUserPrompt(line) {
  if (line?.type !== 'user') return false;
  if (line.isMeta || line.isCompactSummary) return false;
  if (line.toolUseResult !== undefined) return false;
  const c = line.message?.content;
  if (typeof c === 'string') return c.trim().length > 0;
  if (Array.isArray(c)) {
    if (c.some((b) => b?.type === 'tool_result')) return false;
    return c.some((b) => b?.type === 'text' && typeof b.text === 'string' && b.text.trim().length > 0);
  }
  return false;
}

// Walk the transcript in file order, tracking the active permission mode (flipped by type:'mode'
// lines, which may themselves lack timestamps). Classify each interval between consecutive
// timestamped anchors, then merge adjacent same-state runs into periods.
function buildPeriods(lines) {
  let currentMode = 'default';
  const anchors = [];
  for (const line of lines) {
    if (line?.type === 'mode' && typeof line.mode === 'string') {
      currentMode = line.mode;
      continue;
    }
    const ms = tsOf(line);
    if (ms == null) continue;
    anchors.push({ ts: ms, isPrompt: isRealUserPrompt(line), mode: currentMode });
  }
  anchors.sort((a, b) => a.ts - b.ts);

  const merged = [];
  for (let i = 1; i < anchors.length; i++) {
    const prev = anchors[i - 1];
    const cur = anchors[i];
    if (cur.ts <= prev.ts) continue;
    let state;
    if (cur.isPrompt) state = STATE.WAITING_USER;
    else if (cur.ts - prev.ts > IDLE_GAP_SEC * 1000) state = STATE.IDLE;
    else state = isPlanMode(cur.mode) ? STATE.PLANNING : STATE.WORKING;

    const last = merged[merged.length - 1];
    if (last && last.state === state) last.endMs = cur.ts;
    else merged.push({ state, startMs: prev.ts, endMs: cur.ts });
  }
  return merged.map((m) => ({
    state: m.state,
    started_at: new Date(m.startMs).toISOString(),
    ended_at: new Date(m.endMs).toISOString(),
  }));
}

// One active span per subagent transcript (first→last timestamp). Parallel subagents overlap in
// time; the client packs them into lanes.
function buildSubagents(transcriptPath, sessionId) {
  const out = [];
  for (const { agentId, path: agentPath, agentType } of listSubagentTranscripts(transcriptPath, sessionId)) {
    let times;
    try {
      times = parseTranscript(agentPath).map(tsOf).filter((t) => t != null);
    } catch { continue; }
    if (!times.length) continue;
    times.sort((a, b) => a - b);
    out.push({
      agent_id: agentId,
      agent_type: agentType,
      started_at: new Date(times[0]).toISOString(),
      ended_at: new Date(times[times.length - 1]).toISOString(),
    });
  }
  return out;
}

// Derive the whole session timeline from the transcript. Returns null when there's nothing to
// place on a time axis (no timestamped lines). generated_at stamps when it was computed.
export function computeSessionTimeline(transcriptPath, sessionId) {
  let lines;
  try { lines = parseTranscript(transcriptPath); } catch { return null; }

  const periods = buildPeriods(lines);
  const subagents = buildSubagents(transcriptPath, sessionId);

  // Axis domain = earliest/latest timestamp across main + subagent activity. Single-pass min/max
  // rather than collecting and sorting every timestamp just to read the two extremes.
  let minTs = Infinity;
  let maxTs = -Infinity;
  const track = (t) => {
    if (t < minTs) minTs = t;
    if (t > maxTs) maxTs = t;
  };
  for (const line of lines) {
    const t = tsOf(line);
    if (t != null) track(t);
  }
  for (const s of subagents) {
    track(Date.parse(s.started_at));
    track(Date.parse(s.ended_at));
  }
  if (minTs === Infinity) return null;

  return {
    periods,
    subagents,
    started_at: new Date(minTs).toISOString(),
    ended_at: new Date(maxTs).toISOString(),
    generated_at: new Date().toISOString(),
  };
}

// POST the session timeline to Beezi. Session-scoped (upserted by sessionId), fire-and-forget by
// convention — callers swallow the result. Mirrors session-error-report.mjs.
export async function postSessionTimeline(payload, token, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  if (!payload?.sessionId || !Array.isArray(payload?.periods)) {
    return { reported: false, reason: 'missing-fields' };
  }
  if (!token) return { reported: false, reason: 'no-token' };
  try {
    const res = await postJson(`${apiBase()}${ENDPOINTS.sessionsTimeline}`, token, payload, { fetchImpl });
    return { reported: res.status >= 200 && res.status < 300, status: res.status };
  } catch {
    return { reported: false, reason: 'network' };
  }
}
