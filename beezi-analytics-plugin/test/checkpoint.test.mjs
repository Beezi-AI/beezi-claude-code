import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCheckpoint, flushQueue } from '../lib/checkpoint.mjs';

// ─── helpers ────────────────────────────────────────────────────────────────

function makeTmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));
  return dir;
}

function setHome(dir) {
  process.env.BEEZI_HOME = dir;
}

function assistantLine(branch, model, usage, timestamp, cwd) {
  return {
    type: 'assistant',
    gitBranch: branch,
    ...(cwd === undefined ? {} : { cwd }),
    timestamp,
    message: { model, usage },
  };
}

function writeTranscript(dir, lines) {
  const p = path.join(dir, `t-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
  fs.writeFileSync(p, lines.map(l => JSON.stringify(l)).join('\n'), 'utf-8');
  return p;
}

// Retained for tests 1, 7, 12, 13 (specified as untouched): those never reach a
// resolver call that cares about subcommand routing (no-token / zero-work / thrown
// getToken / missing-transcript all short-circuit before or around git resolution),
// so the old blanket-remote fake is still adequate for them.
function fakeGit(remote) {
  return (_args, _cwd) => remote;
}

// Single-repo router: repo root is identity (the cwd passed to rev-parse), no reflog
// events (empty), current HEAD = `branch`, origin = `remote`.
function fakeGitRepo(branch, remote, reflog = '') {
  return (args, cwd) => {
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return cwd;
    if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return branch;
    if (args[0] === 'reflog') return reflog;
    if (args[0] === 'remote') return remote;
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
}

// Multi-repo router: `spec` maps a repo root → { branch, remote, reflog? }.
// rev-parse --show-toplevel is identity (dir passed IS the root); other calls look up by root.
function fakeGitByRoot(spec) {
  return (args, cwd) => {
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return cwd;
    const entry = spec[cwd];
    if (!entry) throw new Error(`no repo for ${cwd}`);
    if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return entry.branch;
    if (args[0] === 'reflog') return entry.reflog ?? '';
    if (args[0] === 'remote') {
      if (entry.remote == null) throw new Error(`no origin for ${cwd}`);
      return entry.remote;
    }
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
}

// Build an assistant line whose tool_use touches a file in `repoDir` (the repo-signal source).
function repoAssistantLine(repoDir, branchIgnored, model, usage, timestamp) {
  return {
    type: 'assistant',
    gitBranch: branchIgnored,
    timestamp,
    message: { model, usage, content: [{ type: 'tool_use', name: 'Edit', input: { file_path: `${repoDir}/f.ts` } }] },
  };
}

function fakeFetch(status) {
  return async (_url, _opts) => ({ status });
}

function readQueue(homeDir) {
  const qdir = path.join(homeDir, 'queue');
  try {
    return fs.readdirSync(qdir).map(f => ({
      name: f,
      payload: JSON.parse(fs.readFileSync(path.join(qdir, f), 'utf-8')),
    }));
  } catch {
    return [];
  }
}

function readState(homeDir, sessionId) {
  try {
    return JSON.parse(fs.readFileSync(path.join(homeDir, 'state', `${sessionId}.json`), 'utf-8'));
  } catch {
    return null;
  }
}

// ─── test 1: no token → nothing enqueued ────────────────────────────────────

test('1. no token → enqueues nothing, writes no state, fetch never called', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);

  let fetchCalled = false;
  const fetchImpl = async () => { fetchCalled = true; return { status: 200 }; };

  const transcript = writeTranscript(dir, [
    assistantLine('feature/task-1', 'model-a', { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, '2024-01-01T10:00:00.000Z'),
  ]);

  await runCheckpoint(
    { session_id: 'sess-1', transcript_path: transcript, cwd: dir },
    { getToken: async () => null, gitImpl: fakeGit('https://host/org/repo.git'), fetchImpl },
  );

  assert.equal(readQueue(dir).length, 0, 'no queue files');
  assert.equal(readState(dir, 'sess-1'), null, 'no state file');
  assert.equal(fetchCalled, false, 'fetch must not be called');
});

// ─── test 2: git failure → segment skipped, cursor still advances ────────────

test('2. git failure per-cwd → segment skipped (no enqueue/flush), cursor still advances', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);

  let fetchCalled = false;
  const fetchImpl = async () => { fetchCalled = true; return { status: 200 }; };

  const transcript = writeTranscript(dir, [
    assistantLine('feature/task-1', 'model-a', { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, '2024-01-01T10:00:00.000Z'),
  ]);

  await runCheckpoint(
    { session_id: 'sess-2', transcript_path: transcript, cwd: dir },
    {
      getToken: async () => 'tok',
      gitImpl: () => { throw new Error('git not available'); },
      fetchImpl,
    },
  );

  // Per-cwd remote resolution returns null on git failure → segment skipped,
  // nothing enqueued and no fetch, but the cursor advances past the processed line.
  assert.equal(readQueue(dir).length, 0, 'no queue files (remote unresolved → segment skipped)');
  assert.equal(fetchCalled, false, 'fetch must not be called');
  const state = readState(dir, 'sess-2');
  assert.ok(state, 'state file must exist');
  assert.equal(state.cursor, 1, 'cursor advances even when the remote cannot be resolved');
});

// ─── test 3: task-branch segment enqueued with correct payload ───────────────

test('3. task-branch segment enqueued with correct segmentId, remote, branch, lines, token_total, models', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);

  const transcript = writeTranscript(dir, [
    assistantLine('feature/task-1', 'model-a', { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, '2024-01-01T10:00:00.000Z'),
  ]);

  await runCheckpoint(
    { session_id: 'sess-3', transcript_path: transcript, cwd: dir },
    {
      getToken: async () => 'tok',
      gitImpl: fakeGitRepo('feature/task-1', 'https://host/org/repo.git'),
      fetchImpl: fakeFetch(200),
    },
  );

  // Queue was flushed (200 → unlinked), so check state instead
  const state = readState(dir, 'sess-3');
  assert.ok(state, 'state file must exist');
  assert.equal(state.cursor, 1);

  // Re-run with a non-flushing fetch to catch queue file before deletion
  const dir2 = makeTmpDir(t);
  setHome(dir2);

  const transcript2 = writeTranscript(dir2, [
    assistantLine('feature/task-1', 'model-a', { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, '2024-01-01T10:00:00.000Z'),
  ]);

  await runCheckpoint(
    { session_id: 'sess-3b', transcript_path: transcript2, cwd: dir2 },
    {
      getToken: async () => 'tok',
      gitImpl: fakeGitRepo('feature/task-1', 'https://host/org/repo.git'),
      fetchImpl: fakeFetch(503), // keep file
    },
  );

  const items = readQueue(dir2);
  assert.equal(items.length, 1, 'exactly one queue file');

  const { payload } = items[0];
  assert.equal(payload.segmentId, 'sess-3b:1-1');
  assert.equal(payload.sessionId, 'sess-3b');
  assert.equal(payload.remote, 'https://host/org/repo.git');
  assert.equal(payload.branch, 'feature/task-1');
  assert.equal(payload.from_line, 1);
  assert.equal(payload.to_line, 1);
  assert.equal(payload.token_total, 150); // 100 + 50
  assert.ok(payload.models && payload.models['model-a'], 'models.model-a must exist');
});

// ─── test 4: non-task branch now enqueued (all-branches), cursor advances ────

test('4. non-task branch is enqueued (all branches reported), cursor advances', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);

  const transcript = writeTranscript(dir, [
    assistantLine('main', 'model-a', { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, '2024-01-01T10:00:00.000Z'),
  ]);

  await runCheckpoint(
    { session_id: 'sess-4', transcript_path: transcript, cwd: dir },
    {
      getToken: async () => 'tok',
      gitImpl: fakeGitRepo('main', 'https://host/org/repo.git'),
      fetchImpl: fakeFetch(503), // keep file so we can inspect the enqueued segment
    },
  );

  const items = readQueue(dir);
  assert.equal(items.length, 1, 'non-task branch segment is enqueued');
  assert.equal(items[0].payload.branch, 'main', 'branch preserved on the enqueued segment');
  assert.equal(items[0].payload.token_total, 150, '100 + 50');

  const state = readState(dir, 'sess-4');
  assert.ok(state, 'state must exist');
  assert.equal(state.cursor, 1, 'cursor advanced to 1');
});

// ─── test 5: cursor advances / second run processes only new lines ───────────

test('5. second run only processes new lines (cursor advances disjointly)', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);

  const filePath = path.join(dir, 'transcript.jsonl');
  const line1 = assistantLine('feature/task-1', 'model-a', { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, '2024-01-01T10:00:00.000Z');
  fs.writeFileSync(filePath, JSON.stringify(line1), 'utf-8');

  const capturedPayloads = [];
  const fetchImpl = async (_url, opts) => {
    capturedPayloads.push(JSON.parse(opts.body));
    return { status: 200 };
  };

  const deps = {
    getToken: async () => 'tok',
    gitImpl: fakeGitRepo('feature/task-1', 'https://host/org/repo.git'),
    fetchImpl,
  };

  // First run
  await runCheckpoint({ session_id: 'sess-5', transcript_path: filePath, cwd: dir }, deps);
  assert.equal(capturedPayloads.length, 1, 'first run enqueues one segment');
  const first = capturedPayloads[0];
  assert.equal(first.from_line, 1);
  assert.equal(first.to_line, 1);

  // Append a second line
  const line2 = assistantLine('feature/task-1', 'model-a', { input_tokens: 20, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, '2024-01-01T10:01:00.000Z');
  fs.appendFileSync(filePath, '\n' + JSON.stringify(line2), 'utf-8');

  // Second run
  await runCheckpoint({ session_id: 'sess-5', transcript_path: filePath, cwd: dir }, deps);
  assert.equal(capturedPayloads.length, 2, 'second run enqueues one more segment');
  const second = capturedPayloads[1];
  assert.ok(second.from_line > first.to_line, 'second segment starts after first ended');
  assert.equal(second.token_total, 30, 'second run only counts line 2 tokens (20+10)');
});

// ─── test 6: nothing new → no new queue files, state unchanged ──────────────

test('6. nothing new → early return, no queue files, state unchanged', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);

  const transcript = writeTranscript(dir, [
    assistantLine('feature/task-1', 'model-a', { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, '2024-01-01T10:00:00.000Z'),
  ]);

  const deps = {
    getToken: async () => 'tok',
    gitImpl: fakeGitRepo('feature/task-1', 'https://host/org/repo.git'),
    fetchImpl: fakeFetch(200),
  };

  // First run to advance cursor
  await runCheckpoint({ session_id: 'sess-6', transcript_path: transcript, cwd: dir }, deps);
  const stateAfterFirst = readState(dir, 'sess-6');

  // Second run with same transcript (cursor == EOF)
  let fetchCalled = false;
  const fetchImpl2 = async () => { fetchCalled = true; return { status: 200 }; };
  await runCheckpoint({ session_id: 'sess-6', transcript_path: transcript, cwd: dir }, { ...deps, fetchImpl: fetchImpl2 });

  const stateAfterSecond = readState(dir, 'sess-6');
  assert.deepEqual(stateAfterSecond, stateAfterFirst, 'state unchanged on second run');
  assert.equal(fetchCalled, false, 'fetch not called when nothing new');
});

// ─── test 7: zero-work segment skipped ──────────────────────────────────────

test('7. zero-work task-branch segment not enqueued', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);

  // Non-assistant line on a task branch (no tokens, no duration)
  const line = { type: 'mode', mode: 'auto', sessionId: 'x', gitBranch: 'feature/task-1' };
  const filePath = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(filePath, JSON.stringify(line), 'utf-8');

  let fetchCalled = false;
  const fetchImpl = async () => { fetchCalled = true; return { status: 200 }; };

  await runCheckpoint(
    { session_id: 'sess-7', transcript_path: filePath, cwd: dir },
    {
      getToken: async () => 'tok',
      gitImpl: fakeGit('https://host/org/repo.git'),
      fetchImpl,
    },
  );

  // Queue should be empty (segment dropped for zero work)
  // Note: flushQueue is still called but with an empty queue → no fetch
  assert.equal(fetchCalled, false, 'fetch not called for zero-work segment');
  // State cursor must still advance
  const state = readState(dir, 'sess-7');
  assert.ok(state, 'state file must exist');
  assert.equal(state.cursor, 1, 'cursor advanced past zero-work line');
});

// ─── test 8: remote sanitized ───────────────────────────────────────────────

test('8. remote sanitized — user:pass@ stripped from payload', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);

  const capturedPayloads = [];
  const fetchImpl = async (_url, opts) => {
    capturedPayloads.push(JSON.parse(opts.body));
    return { status: 503 }; // keep in queue so we can inspect
  };

  const transcript = writeTranscript(dir, [
    assistantLine('feature/task-1', 'model-a', { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, '2024-01-01T10:00:00.000Z'),
  ]);

  await runCheckpoint(
    { session_id: 'sess-8', transcript_path: transcript, cwd: dir },
    {
      getToken: async () => 'tok',
      gitImpl: fakeGitRepo('feature/task-1', 'https://user:pw@host/org/repo.git'),
      fetchImpl,
    },
  );

  assert.equal(capturedPayloads.length, 1);
  assert.equal(capturedPayloads[0].remote, 'https://host/org/repo.git', 'credentials stripped from remote');
  assert.ok(!capturedPayloads[0].remote.includes('user:pw@'), 'no user:pw@ in remote');
});

// ─── test 9: flushQueue delivers + unlinks on 2xx ───────────────────────────

test('9. flushQueue delivers and unlinks on 2xx', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);

  // Seed a queue file directly
  const qdir = path.join(dir, 'queue');
  fs.mkdirSync(qdir, { recursive: true });
  const payload = { segmentId: 'sess-9:1-1', sessionId: 'sess-9', remote: 'https://host/repo.git', branch: 'feature/task-1', token_total: 100 };
  const filePath = path.join(qdir, 'sess-9_1-1.json');
  fs.writeFileSync(filePath, JSON.stringify(payload), 'utf-8');

  const fetchCalls = [];
  const fetchImpl = async (url, opts) => {
    fetchCalls.push({ url, opts });
    return { status: 200 };
  };

  await flushQueue('my-token', { fetchImpl });

  // File must be unlinked
  assert.equal(fs.existsSync(filePath), false, 'queue file must be removed on 2xx');
  assert.equal(fetchCalls.length, 1, 'fetch called once');
  assert.ok(fetchCalls[0].url.includes('/sessions/report'), 'correct endpoint');
  assert.equal(fetchCalls[0].opts.headers['Authorization'], 'Bearer my-token', 'Bearer token sent');
});

// ─── test 10: flushQueue keeps on 5xx and on throw ──────────────────────────

test('10. flushQueue keeps file on 5xx and on throw', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);

  const qdir = path.join(dir, 'queue');
  fs.mkdirSync(qdir, { recursive: true });

  // File 1: 5xx response
  const p1 = path.join(qdir, 'seg-503.json');
  fs.writeFileSync(p1, JSON.stringify({ segmentId: 'sess-10a:1-1' }), 'utf-8');

  // File 2: throwing fetch
  const p2 = path.join(qdir, 'seg-throw.json');
  fs.writeFileSync(p2, JSON.stringify({ segmentId: 'sess-10b:1-1' }), 'utf-8');

  let callCount = 0;
  const fetchImpl = async (_url, opts) => {
    callCount++;
    const body = JSON.parse(opts.body);
    if (body.segmentId === 'sess-10a:1-1') return { status: 503 };
    throw new Error('network error');
  };

  await flushQueue('tok', { fetchImpl });

  assert.equal(fs.existsSync(p1), true, 'file kept on 503');
  assert.equal(fs.existsSync(p2), true, 'file kept on throw');
  assert.equal(callCount, 2, 'fetch called for both files');
});

// ─── test 11: flushQueue drops on 4xx ───────────────────────────────────────

test('11. flushQueue drops on 4xx (terminal reject)', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);

  const qdir = path.join(dir, 'queue');
  fs.mkdirSync(qdir, { recursive: true });

  const p = path.join(qdir, 'seg-422.json');
  fs.writeFileSync(p, JSON.stringify({ segmentId: 'sess-11:1-1' }), 'utf-8');

  await flushQueue('tok', { fetchImpl: fakeFetch(422) });

  assert.equal(fs.existsSync(p), false, 'file removed on 422');
});

// ─── test 12: getToken throws → resolves without throw, nothing enqueued (FIX 2) ─

test('12. getToken throws → resolves without throw, nothing enqueued (FIX 2 regression)', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);

  let fetchCalled = false;
  const fetchImpl = async () => { fetchCalled = true; return { status: 200 }; };

  const transcript = writeTranscript(dir, [
    assistantLine('feature/task-1', 'model-a', { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, '2024-01-01T10:00:00.000Z'),
  ]);

  await assert.doesNotReject(async () => {
    await runCheckpoint(
      { session_id: 'sess-12', transcript_path: transcript, cwd: dir },
      {
        getToken: async () => { throw new Error('keytar not available'); },
        gitImpl: fakeGit('https://host/org/repo.git'),
        fetchImpl,
      },
    );
  });

  assert.equal(readQueue(dir).length, 0, 'no queue files when getToken throws');
  assert.equal(readState(dir, 'sess-12'), null, 'no state file when getToken throws');
  assert.equal(fetchCalled, false, 'fetch must not be called when getToken throws');
});

// ─── test 13: missing transcript → resolves without throw, nothing enqueued (FIX 3) ─

test('13. missing transcript → resolves without throw, nothing enqueued (FIX 3 regression)', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);

  let fetchCalled = false;
  const fetchImpl = async () => { fetchCalled = true; return { status: 200 }; };

  const nonExistentPath = path.join(dir, 'does-not-exist.jsonl');

  await assert.doesNotReject(async () => {
    await runCheckpoint(
      { session_id: 'sess-13', transcript_path: nonExistentPath, cwd: dir },
      {
        getToken: async () => 'tok',
        gitImpl: fakeGit('https://host/org/repo.git'),
        fetchImpl,
      },
    );
  });

  assert.equal(readQueue(dir).length, 0, 'no queue files for missing transcript');
  assert.equal(fetchCalled, false, 'fetch must not be called for missing transcript');
});

// ─── test 14: empty transcript → cursor stays 0; then first line IS reported (FIX 5 end-to-end) ─

test('14. empty transcript → cursor stays 0; first real line IS reported on next run (FIX 5 end-to-end)', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);

  const filePath = path.join(dir, 'transcript-e2e.jsonl');
  // Start with an empty transcript
  fs.writeFileSync(filePath, '', 'utf-8');

  const deps = {
    getToken: async () => 'tok',
    gitImpl: fakeGitRepo('feature/task-14', 'https://host/org/repo.git'),
    fetchImpl: fakeFetch(200),
  };

  // First checkpoint on empty file → nothing enqueued, cursor must remain 0
  await runCheckpoint({ session_id: 'sess-14', transcript_path: filePath, cwd: dir }, deps);

  const stateAfterEmpty = readState(dir, 'sess-14');
  assert.equal(stateAfterEmpty, null, 'no state file written for empty transcript (cursor stays at default 0)');
  assert.equal(readQueue(dir).length, 0, 'no queue files for empty transcript');

  // Append one task-branch assistant line
  const line = assistantLine('feature/task-14', 'model-a', { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, '2024-01-01T10:00:00.000Z');
  fs.writeFileSync(filePath, JSON.stringify(line), 'utf-8');

  const capturedPayloads = [];
  const recordingDeps = {
    getToken: async () => 'tok',
    gitImpl: fakeGitRepo('feature/task-14', 'https://host/org/repo.git'),
    fetchImpl: async (_url, opts) => {
      capturedPayloads.push(JSON.parse(opts.body));
      return { status: 200 };
    },
  };

  // Second checkpoint — should report the first (and only) line
  await runCheckpoint({ session_id: 'sess-14', transcript_path: filePath, cwd: dir }, recordingDeps);

  assert.equal(capturedPayloads.length, 1, 'exactly one segment reported after first real line');
  const seg = capturedPayloads[0];
  assert.equal(seg.from_line, 1, 'segment starts at line 1 (not 2 — FIX 1 was applied)');
  assert.equal(seg.to_line, 1, 'segment ends at line 1');
  assert.equal(seg.token_total, 15, 'correct token total for first line (10+5)');
});

// ─── test 15: two repos by tool-path signal → each segment gets its own remote ──

test('15. two repos touched in one session → each segment resolves its own repo remote', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);

  const u = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const transcript = writeTranscript(dir, [
    repoAssistantLine('/repo/alpha', 'frozen', 'model-a', u, '2024-01-01T10:00:00.000Z'),
    repoAssistantLine('/repo/beta', 'frozen', 'model-a', { input_tokens: 200, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, '2024-01-01T10:01:00.000Z'),
  ]);

  const captured = [];
  await runCheckpoint(
    { session_id: 'sess-15', transcript_path: transcript, cwd: '/repo/alpha' },
    {
      getToken: async () => 'tok',
      gitImpl: fakeGitByRoot({
        '/repo/alpha': { branch: 'feature/task-a', remote: 'https://host/org/alpha.git' },
        '/repo/beta': { branch: 'feature/task-b', remote: 'https://host/org/beta.git' },
      }),
      fetchImpl: async (_url, opts) => { captured.push(JSON.parse(opts.body)); return { status: 503 }; },
    },
  );

  assert.equal(captured.length, 2, 'one segment per repo');
  const alpha = captured.find((p) => p.remote === 'https://host/org/alpha.git');
  const beta = captured.find((p) => p.remote === 'https://host/org/beta.git');
  assert.ok(alpha, 'alpha segment resolved its own remote');
  assert.ok(beta, 'beta segment resolved its own remote');
  assert.equal(alpha.branch, 'feature/task-a');
  assert.equal(beta.branch, 'feature/task-b');
  assert.equal(alpha.token_total, 150);
  assert.equal(beta.token_total, 220);
});

// ─── test 16: reflog interleave within ONE repo → branch by timestamp ───────────

test('16. reflog interleave within a repo → branch attributed by line timestamp', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);

  const CP_REFLOG = [
    'e3 HEAD@{2026-07-03T10:04:00+00:00}: checkout: moving from main to feature/task-A',
    'e2 HEAD@{2026-07-03T10:02:00+00:00}: checkout: moving from feature/task-A to main',
    'e1 HEAD@{2026-07-03T10:00:00+00:00}: checkout: moving from main to feature/task-A',
  ].join('\n');

  const u = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const transcript = writeTranscript(dir, [
    repoAssistantLine('/repo/x', 'frozen', 'model-a', u, '2026-07-03T10:00:30.000Z'), // → feature/task-A
    repoAssistantLine('/repo/x', 'frozen', 'model-a', u, '2026-07-03T10:02:30.000Z'), // → main
    repoAssistantLine('/repo/x', 'frozen', 'model-a', u, '2026-07-03T10:04:30.000Z'), // → feature/task-A
  ]);

  const captured = [];
  await runCheckpoint(
    { session_id: 'sess-16', transcript_path: transcript, cwd: '/repo/x' },
    {
      getToken: async () => 'tok',
      gitImpl: fakeGitByRoot({ '/repo/x': { branch: 'IGNORED-HEAD', remote: 'https://host/org/x.git', reflog: CP_REFLOG } }),
      fetchImpl: async (_url, opts) => { captured.push(JSON.parse(opts.body)); return { status: 503 }; },
    },
  );

  const branches = captured.map((p) => p.branch);
  assert.deepEqual(branches, ['feature/task-A', 'main', 'feature/task-A'], 'reflog timestamps drive branch, not HEAD');
  // Disjoint ranges across the three runs.
  const ranges = captured.map((p) => [p.from_line, p.to_line]);
  assert.deepEqual(ranges, [[1, 1], [2, 2], [3, 3]]);
});

// ─── test 17: repo with no origin → its segment is skipped ──────────────────────

test('17. repo without an origin remote → segment skipped, cursor still advances', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);

  const u = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const transcript = writeTranscript(dir, [
    repoAssistantLine('/repo/noorigin', 'frozen', 'model-a', u, '2024-01-01T10:00:00.000Z'),
  ]);

  let fetchCalled = false;
  await runCheckpoint(
    { session_id: 'sess-17', transcript_path: transcript, cwd: '/repo/noorigin' },
    {
      getToken: async () => 'tok',
      gitImpl: fakeGitByRoot({ '/repo/noorigin': { branch: 'feature/task-a', remote: null } }),
      fetchImpl: async () => { fetchCalled = true; return { status: 200 }; },
    },
  );

  assert.equal(readQueue(dir).length, 0, 'no queue file when origin cannot be resolved');
  assert.equal(fetchCalled, false, 'fetch not called');
  const state = readState(dir, 'sess-17');
  assert.ok(state, 'state file exists');
  assert.equal(state.cursor, 1, 'cursor advanced past the skipped segment');
});

// Realistic assistant message = 3 block-lines (thinking/text/tool_use) sharing id + usage.
function multiLineMsg(id, repoDir, usage, ts) {
  const m = (content) => ({ type: 'assistant', gitBranch: 'frozen', timestamp: ts, message: { id, model: 'model-a', usage, content } });
  return [
    m([{ type: 'thinking', thinking: 'x' }]),
    m([{ type: 'text', text: 'y' }]),
    m([{ type: 'tool_use', name: 'Edit', input: { file_path: `${repoDir}/f.ts` } }]),
  ];
}

test('18. realistic multi-line messages across two windows attribute per repo (C1/C2 end-to-end)', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);

  const u = { input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const filePath = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(filePath, multiLineMsg('m1', '/repo/alpha', u, '2024-01-01T10:00:00.000Z').map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf-8');

  const captured = [];
  const deps = {
    getToken: async () => 'tok',
    gitImpl: fakeGitByRoot({
      '/repo/alpha': { branch: 'feature/task-a', remote: 'https://host/org/alpha.git' },
      '/repo/beta': { branch: 'feature/task-b', remote: 'https://host/org/beta.git' },
    }),
    fetchImpl: async (_url, opts) => { captured.push(JSON.parse(opts.body)); return { status: 200 }; },
  };

  await runCheckpoint({ session_id: 'sess-18', transcript_path: filePath, cwd: '/repo/alpha' }, deps);
  assert.equal(captured.length, 1, 'window 1: one segment');
  assert.equal(captured[0].remote, 'https://host/org/alpha.git');
  assert.equal(captured[0].token_total, 100, 'message counted once');

  fs.appendFileSync(filePath, '\n' + multiLineMsg('m2', '/repo/beta', u, '2024-01-01T10:01:00.000Z').map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf-8');
  await runCheckpoint({ session_id: 'sess-18', transcript_path: filePath, cwd: '/repo/alpha' }, deps);

  assert.equal(captured.length, 2, 'window 2: appended message processed (not skipped), one new segment');
  assert.equal(captured[1].remote, 'https://host/org/beta.git', 'window-2 message attributed to repo beta despite launch cwd alpha');
  assert.equal(captured[1].token_total, 100);
  assert.notEqual(captured[0].segmentId, captured[1].segmentId, 'disjoint segmentIds across windows');
});

test('reports rate-limit events to /sessions/errors', async (t) => {
  const dir = makeTmpDir(t);
  setHome(dir);
  const file = writeTranscript(dir, [
    assistantLine('main', 'claude-opus-4-8', { input_tokens: 1, output_tokens: 1 }, '2026-07-08T10:00:00.000Z', '/some/path'),
  ]);

  const calls = [];
  const fetchImpl = async (url, opts) => { calls.push({ url, opts }); return { status: 200 }; };
  const computeDelta = () => ({
    nextCursor: 1,
    segments: [],
    rateLimitEvents: [
      { text: "You've hit your session limit · resets 4:30pm (Europe/Kiev)", occurredAt: '2026-07-08T10:00:00.000Z', lineNo: 1 },
    ],
  });

  await runCheckpoint(
    { session_id: 's1', transcript_path: file, cwd: '/some/path' },
    { getToken: async () => 'tok', gitImpl: fakeGitRepo('main', 'git@github.com:acme/app.git'), computeDelta, fetchImpl },
  );

  const errorCalls = calls.filter((c) => /\/sessions\/errors$/.test(c.url));
  assert.equal(errorCalls.length, 1);
  const body = JSON.parse(errorCalls[0].opts.body);
  assert.equal(body.sessionId, 's1');
  assert.equal(body.error, 'rate_limit');
  assert.match(body.lastAssistantMessage, /resets 4:30pm/);
  assert.equal(body.occurredAt, '2026-07-08T10:00:00.000Z');
});
