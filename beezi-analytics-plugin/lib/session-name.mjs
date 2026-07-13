import fs from 'node:fs';
import path from 'node:path';
import { claudeSessionsDir } from './paths.mjs';
import { readJson } from './fs-store.mjs';

const MAX = 200;

// The live session name Claude Code shows in /status. It writes a per-process descriptor to
// ~/.claude/sessions/<pid>.json holding { sessionId, name, ... }; the file is keyed by pid, so
// we scan and match on sessionId. This name is user-facing and can change after the first prompt
// (Claude Code renames the session), which is exactly what we want to surface in analytics.
export function sessionNameFromStore(sessionId) {
  if (!sessionId) return null;
  const dir = claudeSessionsDir();
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch {
    return null;
  }
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const rec = readJson(path.join(dir, file));
    if (!rec || rec.sessionId !== sessionId) continue;
    const name = typeof rec.name === 'string' ? rec.name.trim() : '';
    return name.slice(0, MAX) || null;
  }
  return null;
}

// Fallback title from the transcript. Preference order: the AI-generated title Claude Code
// writes (`ai-title`, re-emitted as work progresses — the last one is current), else a
// `summary` line, else the first user prompt (truncated), else null.
export function sessionNameFrom(transcriptPath) {
  let content;
  try { content = fs.readFileSync(transcriptPath, 'utf-8'); } catch { return null; }
  let aiTitle = null;
  let summary = null;
  let firstUser = null;
  for (const raw of content.split('\n')) {
    if (!raw.trim()) continue;
    let line;
    try { line = JSON.parse(raw); } catch { continue; }
    if (line.type === 'ai-title' && typeof line.aiTitle === 'string' && line.aiTitle.trim()) {
      aiTitle = line.aiTitle.trim().slice(0, MAX); // keep the latest; Claude Code updates it
    } else if (!summary && line.type === 'summary' && typeof line.summary === 'string') {
      summary = line.summary.slice(0, MAX);
    } else if (!firstUser && line.type === 'user') {
      const text = typeof line.message?.content === 'string'
        ? line.message.content
        : Array.isArray(line.message?.content)
          ? line.message.content.map((c) => c.text ?? '').join(' ')
          : '';
      if (text.trim()) firstUser = text.trim().slice(0, MAX);
    }
  }
  return aiTitle ?? summary ?? firstUser;
}

// Session display name: prefer Claude Code's live session store (the /status name, which updates
// after the first prompt), falling back to the transcript's ai-title / summary / first user prompt.
export function resolveSessionName(sessionId, transcriptPath) {
  return sessionNameFromStore(sessionId) ?? sessionNameFrom(transcriptPath);
}
