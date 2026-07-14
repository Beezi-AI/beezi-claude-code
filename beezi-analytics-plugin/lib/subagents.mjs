import fs from 'node:fs';
import path from 'node:path';

// Read the sibling agent-<id>.meta.json Claude Code writes next to each subagent transcript.
// Holds { agentType, spawnDepth, toolUseId }. Missing/malformed meta yields nulls so the
// caller can still process the transcript (identity fields just go unlabelled).
function readAgentMeta(dir, agentId) {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, `${agentId}.meta.json`), 'utf-8'));
    return {
      agentType: typeof meta?.agentType === 'string' ? meta.agentType : null,
      spawnDepth: typeof meta?.spawnDepth === 'number' ? meta.spawnDepth : null,
    };
  } catch {
    return { agentType: null, spawnDepth: null };
  }
}

// Claude Code writes each subagent's turns to a separate transcript at
// <transcriptDir>/<sessionId>/subagents/agent-<id>.jsonl (the main session file
// contains no sidechain lines). Nested agents (spawnDepth > 1) land in the same
// flat directory. Returns [{ agentId, path, agentType, spawnDepth }] sorted by
// agentId for stable order.
export function listSubagentTranscripts(transcriptPath, sessionId) {
  const dir = path.join(path.dirname(transcriptPath), sessionId, 'subagents');
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return files
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => {
      const agentId = f.slice(0, -'.jsonl'.length);
      return { agentId, path: path.join(dir, f), ...readAgentMeta(dir, agentId) };
    })
    .sort((a, b) => a.agentId.localeCompare(b.agentId));
}
