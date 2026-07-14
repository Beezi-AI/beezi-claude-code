import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listSubagentTranscripts } from '../lib/subagents.mjs';

function makeTmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-subagents-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Layout: <transcriptDir>/<sessionId>.jsonl  +  <transcriptDir>/<sessionId>/subagents/agent-*.jsonl
function setup(t) {
  const transcriptDir = makeTmpDir(t);
  const sessionId = 'sess-1';
  const transcriptPath = path.join(transcriptDir, `${sessionId}.jsonl`);
  fs.writeFileSync(transcriptPath, '', 'utf-8');
  const subagentsDir = path.join(transcriptDir, sessionId, 'subagents');
  fs.mkdirSync(subagentsDir, { recursive: true });
  return { transcriptPath, sessionId, subagentsDir };
}

test('returns agentType and spawnDepth from the sibling meta.json', (t) => {
  const { transcriptPath, sessionId, subagentsDir } = setup(t);
  fs.writeFileSync(path.join(subagentsDir, 'agent-abc.jsonl'), '', 'utf-8');
  fs.writeFileSync(
    path.join(subagentsDir, 'agent-abc.meta.json'),
    JSON.stringify({ agentType: 'Explore', spawnDepth: 2, toolUseId: 'toolu_1' }),
    'utf-8',
  );

  const [entry] = listSubagentTranscripts(transcriptPath, sessionId);
  assert.equal(entry.agentId, 'agent-abc');
  assert.equal(entry.agentType, 'Explore');
  assert.equal(entry.spawnDepth, 2);
});

test('missing or malformed meta.json yields null identity, transcript still listed', (t) => {
  const { transcriptPath, sessionId, subagentsDir } = setup(t);
  fs.writeFileSync(path.join(subagentsDir, 'agent-nometa.jsonl'), '', 'utf-8');
  fs.writeFileSync(path.join(subagentsDir, 'agent-bad.jsonl'), '', 'utf-8');
  fs.writeFileSync(path.join(subagentsDir, 'agent-bad.meta.json'), '{not json', 'utf-8');

  const entries = listSubagentTranscripts(transcriptPath, sessionId);
  assert.equal(entries.length, 2, 'both transcripts listed regardless of meta');
  for (const e of entries) {
    assert.equal(e.agentType, null);
    assert.equal(e.spawnDepth, null);
    assert.ok(e.path.endsWith('.jsonl'));
  }
});

test('no subagents dir → empty list', (t) => {
  const transcriptDir = makeTmpDir(t);
  const transcriptPath = path.join(transcriptDir, 'sess-x.jsonl');
  fs.writeFileSync(transcriptPath, '', 'utf-8');
  assert.deepEqual(listSubagentTranscripts(transcriptPath, 'sess-x'), []);
});
