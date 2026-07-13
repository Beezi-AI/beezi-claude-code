import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeOperations } from '../lib/operations.mjs';

const asstLine = (...blocks) => ({ type: 'assistant', message: { content: blocks } });
const tool = (name, id, input) => ({ type: 'tool_use', name, id, input: input || {} });
const resultLine = (toolUseId, content) => ({
  type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content }] },
});

const zero = () => ({ count: 0, est_tokens: 0 });
const emptyTotals = () => ({
  file: zero(), search: zero(), internet: zero(), mcp: zero(), shell: zero(), other: zero(),
});

test('categorizes each tool into its bucket', () => {
  const lines = [
    asstLine(tool('Read', 't1')),
    asstLine(tool('Grep', 't2')),
    asstLine(tool('WebFetch', 't3')),
    asstLine(tool('mcp__atlassian__search', 't4')),
    asstLine(tool('Bash', 't5')),
    asstLine(tool('Agent', 't6')),
  ];
  const r = computeOperations(lines);
  assert.equal(r.file.count, 1);
  assert.equal(r.search.count, 1);
  assert.equal(r.internet.count, 1);
  assert.equal(r.mcp.count, 1);
  assert.equal(r.shell.count, 1);
  assert.equal(r.other.count, 1);
});

test('PowerShell + all file tools land in shell/file', () => {
  const lines = [
    asstLine(tool('PowerShell', 't1')),
    asstLine(tool('Write', 't2'), tool('Edit', 't3')),
    asstLine(tool('MultiEdit', 't4')),
    asstLine(tool('NotebookEdit', 't5')),
    asstLine(tool('ToolSearch', 't6')),
    asstLine(tool('WebSearch', 't7')),
  ];
  const r = computeOperations(lines);
  assert.equal(r.shell.count, 1);
  assert.equal(r.file.count, 4);
  assert.equal(r.search.count, 1);
  assert.equal(r.internet.count, 1);
});

test('est_tokens = matched tool_result bytes / 4, rounded', () => {
  const lines = [
    asstLine(tool('Read', 't1')),
    resultLine('t1', 'x'.repeat(400)), // 400 bytes → 100 est tokens
  ];
  const r = computeOperations(lines);
  assert.equal(r.file.count, 1);
  assert.equal(r.file.est_tokens, 100);
});

test('tool_result text-block-array form is summed by bytes', () => {
  const lines = [
    asstLine(tool('Grep', 't1')),
    resultLine('t1', [{ type: 'text', text: 'a'.repeat(40) }, { type: 'text', text: 'b'.repeat(40) }]),
  ];
  const r = computeOperations(lines);
  assert.equal(r.search.est_tokens, 20); // 80 bytes / 4
});

test('multiple calls in one category accumulate count + est_tokens', () => {
  const lines = [
    asstLine(tool('Read', 't1')),
    resultLine('t1', 'y'.repeat(80)),
    asstLine(tool('Read', 't2')),
    resultLine('t2', 'z'.repeat(40)),
  ];
  const r = computeOperations(lines);
  assert.equal(r.file.count, 2);
  assert.equal(r.file.est_tokens, 30); // 20 + 10
});

test('a tool_use with no matching result contributes count but 0 est_tokens', () => {
  const r = computeOperations([asstLine(tool('Bash', 't1'))]);
  assert.equal(r.shell.count, 1);
  assert.equal(r.shell.est_tokens, 0);
});

test('empty input → all six categories zeroed', () => {
  assert.deepEqual(computeOperations([]), emptyTotals());
});
