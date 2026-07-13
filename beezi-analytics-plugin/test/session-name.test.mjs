import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sessionNameFrom, sessionNameFromStore, resolveSessionName } from '../lib/session-name.mjs';

function makeTmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));
  return dir;
}

// A temp CLAUDE_CONFIG_DIR with a sessions/ store, restored after the test.
function makeClaudeHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-home-'));
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function writeSession(home, pid, record) {
  const sdir = path.join(home, 'sessions');
  fs.mkdirSync(sdir, { recursive: true });
  fs.writeFileSync(path.join(sdir, `${pid}.json`), JSON.stringify(record), 'utf-8');
}

function writeTranscript(dir, lines) {
  const p = path.join(dir, `t-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
  fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n'), 'utf-8');
  return p;
}

test('sessionNameFrom — prefers the summary line', (t) => {
  const dir = makeTmpDir(t);
  const p = writeTranscript(dir, [
    { type: 'user', message: { content: 'first prompt text' } },
    { type: 'summary', summary: 'Fix the billing detection bug' },
  ]);
  assert.equal(sessionNameFrom(p), 'Fix the billing detection bug');
});

test('sessionNameFrom — falls back to first user prompt (string content)', (t) => {
  const dir = makeTmpDir(t);
  const p = writeTranscript(dir, [
    { type: 'assistant', message: { model: 'x', usage: {} } },
    { type: 'user', message: { content: 'implement session name extraction' } },
    { type: 'user', message: { content: 'a later prompt' } },
  ]);
  assert.equal(sessionNameFrom(p), 'implement session name extraction');
});

test('sessionNameFrom — first user prompt (array content blocks)', (t) => {
  const dir = makeTmpDir(t);
  const p = writeTranscript(dir, [
    { type: 'user', message: { content: [{ text: 'hello' }, { text: 'world' }] } },
  ]);
  assert.equal(sessionNameFrom(p), 'hello world');
});

test('sessionNameFrom — truncates to 200 chars', (t) => {
  const dir = makeTmpDir(t);
  const long = 'x'.repeat(500);
  const p = writeTranscript(dir, [{ type: 'summary', summary: long }]);
  assert.equal(sessionNameFrom(p).length, 200);
});

test('sessionNameFrom — null when no summary and no user text', (t) => {
  const dir = makeTmpDir(t);
  const p = writeTranscript(dir, [
    { type: 'assistant', message: { model: 'x', usage: {} } },
    { type: 'user', message: { content: '   ' } },
  ]);
  assert.equal(sessionNameFrom(p), null);
});

test('sessionNameFrom — null (read-safe) when the file does not exist', () => {
  assert.equal(sessionNameFrom(path.join(os.tmpdir(), 'does-not-exist-xyz.jsonl')), null);
});

test('sessionNameFrom — skips malformed JSON lines and blank lines', (t) => {
  const dir = makeTmpDir(t);
  const p = path.join(dir, 'mixed.jsonl');
  fs.writeFileSync(p, [
    'not json at all',
    '',
    JSON.stringify({ type: 'user', message: { content: 'good prompt' } }),
  ].join('\n'), 'utf-8');
  assert.equal(sessionNameFrom(p), 'good prompt');
});

test('sessionNameFromStore — returns the live session name matched by sessionId', (t) => {
  const home = makeClaudeHome(t);
  writeSession(home, 111, { sessionId: 'other', name: 'wrong' });
  writeSession(home, 222, { sessionId: 'abc-123', name: 'analytics-session-truncate-fix' });
  assert.equal(sessionNameFromStore('abc-123'), 'analytics-session-truncate-fix');
});

test('sessionNameFromStore — trims and truncates to 200 chars', (t) => {
  const home = makeClaudeHome(t);
  writeSession(home, 1, { sessionId: 's', name: `  ${'x'.repeat(500)}  ` });
  assert.equal(sessionNameFromStore('s').length, 200);
});

test('sessionNameFromStore — null when the matched record has no usable name', (t) => {
  const home = makeClaudeHome(t);
  writeSession(home, 1, { sessionId: 's', name: '   ' });
  writeSession(home, 2, { sessionId: 's2' });
  assert.equal(sessionNameFromStore('s'), null);
  assert.equal(sessionNameFromStore('s2'), null);
});

test('sessionNameFromStore — null when no record matches / dir missing', (t) => {
  const home = makeClaudeHome(t);
  assert.equal(sessionNameFromStore('nope'), null, 'sessions dir absent → null');
  writeSession(home, 1, { sessionId: 's', name: 'x' });
  assert.equal(sessionNameFromStore('missing'), null, 'no matching sessionId → null');
  assert.equal(sessionNameFromStore(''), null, 'empty sessionId → null');
});

test('resolveSessionName — store name wins over the transcript summary', (t) => {
  const home = makeClaudeHome(t);
  writeSession(home, 1, { sessionId: 'sid', name: 'the-real-name' });
  const dir = makeTmpDir(t);
  const p = writeTranscript(dir, [{ type: 'summary', summary: 'Transcript summary' }]);
  assert.equal(resolveSessionName('sid', p), 'the-real-name');
});

test('resolveSessionName — falls back to transcript when the store has no match', (t) => {
  makeClaudeHome(t); // empty store
  const dir = makeTmpDir(t);
  const p = writeTranscript(dir, [
    { type: 'user', message: { content: 'first prompt' } },
    { type: 'summary', summary: 'Summary title' },
  ]);
  assert.equal(resolveSessionName('sid', p), 'Summary title');
});
