import fs from 'node:fs';
import path from 'node:path';
import { claudeProjectsDir } from './paths.mjs';

// Claude Code stores transcripts under a per-project dir named from the cwd with
// every non-alphanumeric character replaced by '-'.
function encodeCwd(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

function newestJsonl(dir) {
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return null;
  }
  let best = null;
  for (const file of files) {
    const full = path.join(dir, file);
    let mtime;
    try {
      mtime = fs.statSync(full).mtimeMs;
    } catch {
      continue;
    }
    if (!best || mtime > best.mtime) {
      best = { full, mtime, sessionId: file.slice(0, -'.jsonl'.length) };
    }
  }
  return best;
}

function transcriptMatchesCwd(file, cwd) {
  let content;
  try {
    content = fs.readFileSync(file, 'utf-8');
  } catch {
    return false;
  }
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed.cwd) return parsed.cwd === cwd;
  }
  return false;
}

// Locate the current session's transcript for `cwd`.
// Returns { sessionId, transcriptPath } or null.
export function findCurrentTranscript(cwd) {
  const root = claudeProjectsDir();

  const primary = newestJsonl(path.join(root, encodeCwd(cwd)));
  if (primary) return { sessionId: primary.sessionId, transcriptPath: primary.full };

  // Fallback: encoding mismatch — scan project dirs for a transcript reporting this cwd.
  let dirs;
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return null;
  }

  let best = null;
  for (const dir of dirs) {
    const candidate = newestJsonl(path.join(root, dir.name));
    if (!candidate) continue;
    if (!transcriptMatchesCwd(candidate.full, cwd)) continue;
    if (!best || candidate.mtime > best.mtime) best = candidate;
  }
  return best ? { sessionId: best.sessionId, transcriptPath: best.full } : null;
}
