import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { computeSessionTimeline, postSessionTimeline } from '../lib/session-timeline.mjs';

const BASE_MS = Date.parse('2026-07-14T10:00:00.000Z');
const ts = (offsetSec) => new Date(BASE_MS + offsetSec * 1000).toISOString();

function makeTmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-timeline-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeJsonl(filePath, lines) {
  fs.writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf-8');
}

// Main transcript: user prompt → work → plan-mode work → tool-result (must NOT read as a prompt) →
// work → long wait for the next prompt → work → >5min idle gap. Plus one subagent transcript.
function setup(t) {
  const dir = makeTmpDir(t);
  const sessionId = 'sess-1';
  const transcriptPath = path.join(dir, `${sessionId}.jsonl`);
  writeJsonl(transcriptPath, [
    { type: 'user', message: { content: 'do X' }, timestamp: ts(0) },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] }, timestamp: ts(10) },
    { type: 'mode', mode: 'plan' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'planning' }] }, timestamp: ts(30) },
    { type: 'mode', mode: 'default' },
    // tool_result echo — type:'user' but carries a tool_result, so it's activity, not a turn-start.
    { type: 'user', toolUseResult: { stdout: '' }, message: { content: [{ type: 'tool_result', content: 'ok' }] }, timestamp: ts(40) },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'more' }] }, timestamp: ts(60) },
    { type: 'user', message: { content: 'next' }, timestamp: ts(600) },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'resume' }] }, timestamp: ts(610) },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'after idle' }] }, timestamp: ts(1000) },
  ]);

  const subagentsDir = path.join(dir, sessionId, 'subagents');
  fs.mkdirSync(subagentsDir, { recursive: true });
  writeJsonl(path.join(subagentsDir, 'agent-abc.jsonl'), [
    { type: 'assistant', timestamp: ts(100) },
    { type: 'assistant', timestamp: ts(200) },
  ]);
  fs.writeFileSync(
    path.join(subagentsDir, 'agent-abc.meta.json'),
    JSON.stringify({ agentType: 'Explore', spawnDepth: 1 }),
    'utf-8',
  );

  return { transcriptPath, sessionId };
}

test('derives merged main-agent state periods from mode lines, prompts, and idle gaps', (t) => {
  const { transcriptPath, sessionId } = setup(t);
  const tl = computeSessionTimeline(transcriptPath, sessionId);

  assert.ok(tl, 'timeline computed');
  // working[0,10] · planning[10,30] · working[30,60] (tool_result merged in) · waiting[60,600] ·
  // working[600,610] · idle[610,1000]
  assert.equal(tl.periods.length, 6);
  assert.equal(tl.periods[0].state, 'working');

  const planning = tl.periods.find((p) => p.state === 'planning');
  assert.deepEqual([planning.started_at, planning.ended_at], [ts(10), ts(30)]);

  const waits = tl.periods.filter((p) => p.state === 'waiting_user');
  assert.equal(waits.length, 1, 'tool_result did not create a spurious wait');
  assert.deepEqual([waits[0].started_at, waits[0].ended_at], [ts(60), ts(600)]);

  assert.ok(tl.periods.some((p) => p.state === 'idle'), 'the >5min gap is idle');
  assert.equal(tl.started_at, ts(0));
  assert.equal(tl.ended_at, ts(1000));
  assert.equal(typeof tl.generated_at, 'string');
});

test('derives one active span per subagent transcript', (t) => {
  const { transcriptPath, sessionId } = setup(t);
  const tl = computeSessionTimeline(transcriptPath, sessionId);

  assert.equal(tl.subagents.length, 1);
  assert.deepEqual(tl.subagents[0], {
    agent_id: 'agent-abc',
    agent_type: 'Explore',
    started_at: ts(100),
    ended_at: ts(200),
  });
});

test('plan-mode is matched loosely so a schema variant still classifies as planning', (t) => {
  const dir = makeTmpDir(t);
  const transcriptPath = path.join(dir, 'plan.jsonl');
  writeJsonl(transcriptPath, [
    { type: 'user', message: { content: 'do X' }, timestamp: ts(0) },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] }, timestamp: ts(10) },
    { type: 'mode', mode: 'plan_mode' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'planning' }] }, timestamp: ts(30) },
  ]);
  const tl = computeSessionTimeline(transcriptPath, 'plan');
  assert.ok(tl.periods.some((p) => p.state === 'planning'), "'plan_mode' read as planning");
});

test('empty transcript yields null (nothing to place on the axis)', (t) => {
  const dir = makeTmpDir(t);
  const transcriptPath = path.join(dir, 'empty.jsonl');
  fs.writeFileSync(transcriptPath, '', 'utf-8');
  assert.equal(computeSessionTimeline(transcriptPath, 'empty'), null);
});

test('postSessionTimeline guards missing fields and reports 2xx as success', async () => {
  const missing = await postSessionTimeline({ periods: [] }, 'tok');
  assert.deepEqual(missing, { reported: false, reason: 'missing-fields' });

  const noToken = await postSessionTimeline({ sessionId: 's', periods: [] }, null);
  assert.deepEqual(noToken, { reported: false, reason: 'no-token' });

  let capturedUrl = null;
  const fetchImpl = async (url) => { capturedUrl = url; return { status: 200 }; };
  const ok = await postSessionTimeline({ sessionId: 's', periods: [] }, 'tok', { fetchImpl });
  assert.equal(ok.reported, true);
  assert.equal(ok.status, 200);
  assert.ok(capturedUrl.endsWith('/sessions/timeline'));
});
