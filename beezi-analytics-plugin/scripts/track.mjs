import { getToken } from '../lib/credentials.mjs';
import { runCheckpoint } from '../lib/checkpoint.mjs';
import { git, resolveOriginRemote, currentBranch, taskFromBranch } from '../lib/git.mjs';
import { findCurrentTranscript } from '../lib/transcript.mjs';

const cwd = process.cwd();

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

async function main() {
  // Branch fit is the primary check — fail fast, before any network work.
  let branch;
  try {
    branch = currentBranch(cwd);
  } catch {
    fail('Beezi: not a git repository — run this inside your project.');
  }

  const task = taskFromBranch(branch);
  if (!task) {
    fail(`Beezi: branch "${branch}" is not a Beezi task branch (expected a .../task-… branch). Nothing tracked.`);
  }

  const token = await getToken().catch(() => null);
  if (!token) fail('Beezi: this machine is not linked. Run /beezi:login first.');

  if (!resolveOriginRemote(git, cwd)) {
    fail('Beezi: this repo has no "origin" remote. Nothing tracked.');
  }

  const transcript = findCurrentTranscript(cwd);
  if (!transcript) {
    fail('Beezi: could not find this session’s transcript to track.');
  }

  const { enqueued, flush } = await runCheckpoint({
    session_id: transcript.sessionId,
    transcript_path: transcript.transcriptPath,
    cwd,
  });

  if (flush?.failed) {
    fail('Beezi: could not reach the server — analytics will be retried automatically.');
  }
  if (flush?.rejected) {
    fail(`Beezi: ${flush.lastError ?? 'the server rejected this report'}.`);
  }

  const saved = flush?.flushed ?? 0;
  if (enqueued === 0 && saved === 0) {
    console.log(`✓ Beezi: nothing new to save for ${task} — already up to date.`);
    return;
  }

  console.log(`✓ Beezi: analytics saved for ${task} (${saved} segment${saved === 1 ? '' : 's'}).`);
}

main().catch((error) => fail(error.message));
