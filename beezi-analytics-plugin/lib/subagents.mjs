import fs from 'node:fs';
import path from 'node:path';

// Claude Code writes each subagent's turns to a separate transcript at
// <transcriptDir>/<sessionId>/subagents/agent-<id>.jsonl (the main session file
// contains no sidechain lines). Nested agents (spawnDepth > 1) land in the same
// flat directory. Returns [{ agentId, path }] sorted by agentId for stable order.
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
    .map((f) => ({ agentId: f.slice(0, -'.jsonl'.length), path: path.join(dir, f) }))
    .sort((a, b) => a.agentId.localeCompare(b.agentId));
}
