import path from 'node:path';

// Match a `cd`/`pushd` (optionally `cd /d`) at a command boundary; capture the target,
// quoted or bare. Global so we can take the LAST match in a compound command.
const CD_RE = /(?:^|&&|;|\|)\s*(?:cd|pushd)\s+(?:\/d\s+)?("[^"]+"|'[^']+'|[^\s;&|]+)/g;

const PATH_TOOLS = new Set(['Read', 'Edit', 'MultiEdit', 'Write']);

// Normalize any OS path to forward slashes so signals from different sources
// (transcript file paths, cd targets, session cwd) share one representation —
// keeps repoRootOf cache keys stable and output deterministic across platforms.
function norm(p) {
  return typeof p === 'string' ? p.replace(/\\/g, '/') : p;
}

// The directory a single tool_use block implies, or null.
function dirFromToolUse(block, cwd) {
  const { name, input } = block;
  if (!input) return null;
  if (PATH_TOOLS.has(name)) {
    return typeof input.file_path === 'string' ? path.posix.dirname(norm(input.file_path)) : null;
  }
  if (name === 'NotebookEdit') {
    return typeof input.notebook_path === 'string' ? path.posix.dirname(norm(input.notebook_path)) : null;
  }
  if (name === 'Bash') {
    return lastCdTarget(input.command, cwd);
  }
  return null;
}

function lastCdTarget(command, cwd) {
  if (typeof command !== 'string') return null;
  let target = null;
  let m;
  CD_RE.lastIndex = 0;
  while ((m = CD_RE.exec(command)) !== null) {
    let t = m[1];
    if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
      t = t.slice(1, -1);
    }
    target = t;
  }
  if (!target || target === '-' || target === '~') return null; // unresolvable targets
  target = norm(target);
  // win32.isAbsolute treats both POSIX ("/repo") and drive ("C:/repo") roots as absolute.
  if (path.win32.isAbsolute(target)) return target;
  return cwd ? path.posix.join(norm(cwd), target) : null;
}

// The active-repo signal for a line: dir of the LAST tool_use block that carries one,
// else null (caller carries the previous active repo forward).
export function extractPathSignal(line, cwd) {
  const content = line?.message?.content;
  if (!Array.isArray(content)) return null;
  let dir = null;
  for (const block of content) {
    if (!block || block.type !== 'tool_use') continue;
    const d = dirFromToolUse(block, cwd);
    if (d) dir = d; // last-touch-wins
  }
  return dir;
}

// git repo root for `dir` (`rev-parse --show-toplevel`), memoized in `cache`.
// Returns null when `dir` is falsy, not in a repo, or git throws.
export function resolveRepoRoot(gitImpl, dir, cache) {
  if (!dir) return null;
  if (cache && cache.has(dir)) return cache.get(dir);
  let root = null;
  try {
    const out = gitImpl(['rev-parse', '--show-toplevel'], dir).trim();
    root = out === '' ? null : out;
  } catch {
    root = null;
  }
  if (cache) cache.set(dir, root);
  return root;
}
