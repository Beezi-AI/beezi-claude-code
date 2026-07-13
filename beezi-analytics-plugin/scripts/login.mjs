import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { apiBase, ENDPOINTS } from '../lib/config.mjs';
import { getToken, setToken } from '../lib/credentials.mjs';
import { beeziHome } from '../lib/paths.mjs';
import { whoami } from '../lib/whoami.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const pendingFile = () => path.join(beeziHome(), 'pending-login.json');

function removePending() {
  try { fs.rmSync(pendingFile(), { force: true }); } catch { /* best-effort */ }
}

function openBrowser(url) {
  // The URL comes from the server response — never pass it through a shell. Require a
  // plain http(s) URL and hand it to the launcher as a single argv element (no shell,
  // no interpolation), so it cannot smuggle command-line metacharacters.
  if (!/^https?:\/\//i.test(url)) return;
  try {
    if (process.platform === 'win32') {
      const sysRoot = process.env.SystemRoot || 'C:\\Windows';
      // Start-Process uses ShellExecute → the default browser's http(s) association, and
      // handles query strings (?code=…&…) correctly. explorer.exe mis-parses such URLs and
      // can pop a File Explorer / search window instead of the browser. Absolute PowerShell
      // path avoids resolving a bare name against the current directory; the URL is passed
      // as an env var, never spliced into the command text, so it can't be run as script.
      const powershell = path.join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', 'Start-Process $env:BEEZI_LOGIN_URL'], {
        stdio: 'ignore',
        env: { ...process.env, BEEZI_LOGIN_URL: url },
      });
    } else if (process.platform === 'darwin') {
      execFileSync('/usr/bin/open', [url], { stdio: 'ignore' });
    } else {
      execFileSync('xdg-open', [url], { stdio: 'ignore' });
    }
  } catch {
    // Non-fatal — the user can open the printed URL manually.
  }
}

async function pollErrorDetail(res) {
  try {
    const body = await res.json();
    return body?.error ?? '';
  } catch {
    return '';
  }
}

// Phase 1: get + display the code, open the browser, then exit fast so the CLI
// shows the code BEFORE the (blocking) approval poll runs.
async function runStart() {
  const base = apiBase();

  const existing = await getToken().catch(() => null);
  if (existing) {
    const who = await whoami(existing, { base });
    if (who?.valid) {
      const account = who.name || who.email;
      const devices = who.deviceCount
        ? ` (${who.deviceCount} device${who.deviceCount === 1 ? '' : 's'} on your account)`
        : '';
      console.log(`\n✓ This machine is already linked to Beezi${account ? ` as ${account}` : ''}${devices}.`);
      console.log('  Nothing to do — manage devices in Beezi → Settings → Connections.\n');
      removePending();
      return;
    }
    // Token missing/revoked → fall through and re-link.
  }

  const startRes = await fetch(`${base}${ENDPOINTS.deviceStart}`, { method: 'POST' });
  if (!startRes.ok) {
    throw new Error(`Could not start device login (HTTP ${startRes.status}). Check BEEZI_API_URL.`);
  }
  const start = await startRes.json();

  fs.mkdirSync(beeziHome(), { recursive: true });
  fs.writeFileSync(
    pendingFile(),
    JSON.stringify({
      device_code: start.device_code,
      deadline: Date.now() + (start.expires_in ?? 600) * 1000,
      intervalMs: Math.min((start.interval ?? 2) * 1000, 2000),
    }),
    'utf-8',
  );

  console.log('\nBeezi analytics — link this machine\n');
  console.log('  ┌───────────────────────────────┐');
  console.log(`  │   Verification code: ${start.user_code}   │`);
  console.log('  └───────────────────────────────┘');
  console.log('  Verify this matches the code shown on the Beezi page.\n');
  const verifyUrl = start.verification_uri_complete ?? start.verification_uri;
  console.log(`  If the browser does not open, go to: ${verifyUrl}\n`);
  console.log('Opening your browser… approve there, and this terminal will finish linking.');
  openBrowser(verifyUrl);
}

// Phase 2: block until the user approves, then store the token.
async function runWait() {
  const base = apiBase();

  let pending;
  try {
    pending = JSON.parse(fs.readFileSync(pendingFile(), 'utf-8'));
  } catch {
    // No pending login (e.g. already linked) — nothing to wait for.
    return;
  }

  const intervalMs = pending.intervalMs ?? 2000;
  let waitMs = 800;

  for (;;) {
    if (Date.now() > pending.deadline) {
      removePending();
      throw new Error('Login timed out before approval. Run /beezi:login again.');
    }
    await sleep(waitMs);
    waitMs = intervalMs;

    const res = await fetch(`${base}${ENDPOINTS.devicePoll}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_code: pending.device_code }),
    });

    if (res.status === 428) continue;

    if (!res.ok) {
      const detail = await pollErrorDetail(res);
      removePending();
      throw new Error(`Device authorization failed (HTTP ${res.status}${detail ? `: ${detail}` : ''}).`);
    }

    const { token } = await res.json();
    const where = await setToken(token);
    removePending();
    console.log(`\n✓ Beezi analytics linked. Token stored in ${where}.`);
    return;
  }
}

const command = process.argv[2] ?? 'start';

(command === 'wait' ? runWait() : runStart()).catch((error) => {
  console.error(`\n✗ ${error.message}`);
  process.exit(1);
});
