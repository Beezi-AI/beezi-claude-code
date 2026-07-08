import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { computeDelta } from '../lib/delta.mjs';

function writeTranscript(t, records) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-cc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const p = path.join(dir, 'session.jsonl');
  fs.writeFileSync(p, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
  return p;
}

test('computeDelta attaches code_changes to each segment', (t) => {
  const p = writeTranscript(t, [
    {
      type: 'assistant',
      timestamp: '2026-07-06T10:00:00.000Z',
      message: {
        id: 'm1',
        model: 'claude-sonnet-4-5-20250929',
        usage: { input_tokens: 10, output_tokens: 5 },
        content: [
          { type: 'tool_use', name: 'Edit', input: { file_path: '/repo/a.ts', old_string: 'x', new_string: 'x\ny' } },
        ],
      },
    },
  ]);

  const { segments } = computeDelta(p, 0, {
    cwd: '/repo',
    repoRootOf: () => '/repo',
    branchAt: () => 'main',
  });

  assert.equal(segments.length, 1);
  assert.deepEqual(segments[0].stats.code_changes, {
    files_changed: 1, lines_added: 2, lines_removed: 1, by_extension: { '.ts': 1 },
  });
});
