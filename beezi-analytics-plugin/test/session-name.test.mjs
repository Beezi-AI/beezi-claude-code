import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sessionNameFrom } from '../lib/session-name.mjs';

function makeTmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));
  return dir;
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
