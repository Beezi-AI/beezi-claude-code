import fs from 'node:fs';

const MAX = 200;

// Best-effort Claude Code session title: a `summary` line if present, else the first
// user prompt (truncated), else null.
export function sessionNameFrom(transcriptPath) {
  let content;
  try { content = fs.readFileSync(transcriptPath, 'utf-8'); } catch { return null; }
  let firstUser = null;
  for (const raw of content.split('\n')) {
    if (!raw.trim()) continue;
    let line;
    try { line = JSON.parse(raw); } catch { continue; }
    if (line.type === 'summary' && typeof line.summary === 'string') {
      return line.summary.slice(0, MAX);
    }
    if (!firstUser && line.type === 'user') {
      const text = typeof line.message?.content === 'string'
        ? line.message.content
        : Array.isArray(line.message?.content)
          ? line.message.content.map((c) => c.text ?? '').join(' ')
          : '';
      if (text.trim()) firstUser = text.trim().slice(0, MAX);
    }
  }
  return firstUser;
}
