import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getToken, setToken, deleteToken } from '../lib/credentials.mjs';

// Point BEEZI_HOME at a temp dir and restore it afterward.
function tmpHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'creds-'));
  const prev = process.env.BEEZI_HOME;
  process.env.BEEZI_HOME = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.BEEZI_HOME;
    else process.env.BEEZI_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

const credsPath = (dir) => path.join(dir, 'credentials.json');

// ── fake OS tools (in-memory), injected via deps.run ──────────────────────────

function macRun(store) {
  return (file, args) => {
    if (file !== 'security') return { ok: false, stdout: '' };
    const sub = args[0];
    if (sub === 'find-generic-password') {
      return store.has('k') ? { ok: true, stdout: store.get('k') + '\n' } : { ok: false, stdout: '' };
    }
    if (sub === 'add-generic-password') { store.set('k', args[args.indexOf('-w') + 1]); return { ok: true, stdout: '' }; }
    if (sub === 'delete-generic-password') { store.delete('k'); return { ok: true, stdout: '' }; }
    return { ok: false, stdout: '' };
  };
}

function secretToolRun(store, installed) {
  return (file, args, input) => {
    if (file !== 'secret-tool') return { ok: false, stdout: '' };
    if (!installed) return { ok: false, stdout: '' };
    const sub = args[0];
    if (sub === '--version') return { ok: true, stdout: 'secret-tool 0.20.5\n' };
    if (sub === 'lookup') return store.has('k') ? { ok: true, stdout: store.get('k') + '\n' } : { ok: false, stdout: '' };
    if (sub === 'store') { store.set('k', input); return { ok: true, stdout: '' }; }
    if (sub === 'clear') { store.delete('k'); return { ok: true, stdout: '' }; }
    return { ok: false, stdout: '' };
  };
}

// Fakes the two Windows PowerShell paths: the Credential Manager P/Invoke (CredWrite/Read/
// Delete) and the DPAPI fallback (Protect/Unprotect, modeled as reversible base64). Toggle
// each independently to exercise the backend chain: credMan → DPAPI-file → plaintext-file.
function winRun({ credMan = true, dpapi = true } = {}) {
  const credStore = new Map(); // stands in for the OS Credential Manager
  return (file, args, input) => {
    // The backend invokes PowerShell by absolute path; match on the basename.
    if (path.basename(String(file)).toLowerCase() !== 'powershell.exe') return { ok: false, stdout: '' };
    const script = args[args.indexOf('-Command') + 1];
    // Credential Manager (primary). CredWrite/CredRead/CredDelete are disjoint substrings.
    if (script.includes('CredWrite')) {
      if (!credMan) return { ok: false, stdout: '' };
      credStore.set('k', input); return { ok: true, stdout: 'OK\n' };
    }
    if (script.includes('CredDelete')) { credStore.delete('k'); return { ok: true, stdout: '' }; }
    if (script.includes('CredRead')) {
      return credMan && credStore.has('k') ? { ok: true, stdout: credStore.get('k') } : { ok: false, stdout: '' };
    }
    // DPAPI fallback. Note: 'Unprotect'.includes('Protect') is true — check Unprotect FIRST.
    if (!dpapi) return { ok: false, stdout: '' };
    if (script.includes('Unprotect')) return { ok: true, stdout: Buffer.from(input.trim(), 'base64').toString('utf-8') + '\n' };
    if (script.includes('Protect')) return { ok: true, stdout: Buffer.from(input, 'utf-8').toString('base64') + '\n' };
    return { ok: true, stdout: '' };
  };
}

// ── macOS ─────────────────────────────────────────────────────────────────────

test('macOS — security keychain round-trip; nothing written to disk', async (t) => {
  const dir = tmpHome(t);
  const deps = { platform: 'darwin', run: macRun(new Map()) };
  await setToken('mac-tok', deps);
  assert.equal(fs.existsSync(credsPath(dir)), false, 'keychain used, no file');
  assert.equal(await getToken(deps), 'mac-tok');
  await deleteToken(deps);
  assert.equal(await getToken(deps), null);
});

// ── Linux ──────────────────────────────────────────────────────────────────────

test('Linux — secret-tool round-trip when libsecret is installed', async (t) => {
  const dir = tmpHome(t);
  const deps = { platform: 'linux', run: secretToolRun(new Map(), true) };
  await setToken('lin-tok', deps);
  assert.equal(fs.existsSync(credsPath(dir)), false, 'keychain used, no file');
  assert.equal(await getToken(deps), 'lin-tok');
  await deleteToken(deps);
  assert.equal(await getToken(deps), null);
});

test('Linux — no secret-tool → falls back to the 0600 file', async (t) => {
  const dir = tmpHome(t);
  const deps = { platform: 'linux', run: secretToolRun(new Map(), false) };
  await setToken('lin-file', deps);
  assert.equal(fs.existsSync(credsPath(dir)), true, 'file fallback written');
  assert.equal(JSON.parse(fs.readFileSync(credsPath(dir), 'utf-8')).token, 'lin-file');
  assert.equal(await getToken(deps), 'lin-file');
});

// ── Windows ─────────────────────────────────────────────────────────────────────

test('Windows — Credential Manager round-trip (primary); nothing written to disk', async (t) => {
  const dir = tmpHome(t);
  const deps = { platform: 'win32', run: winRun() };
  const where = await setToken('win-cred', deps);
  assert.equal(where, 'the Windows Credential Manager');
  assert.equal(fs.existsSync(credsPath(dir)), false, 'Credential Manager used, no file');
  assert.equal(await getToken(deps), 'win-cred');
  await deleteToken(deps);
  assert.equal(await getToken(deps), null);
});

test('Windows — Credential Manager unavailable → DPAPI encrypts at rest (no plaintext in file)', async (t) => {
  const dir = tmpHome(t);
  const deps = { platform: 'win32', run: winRun({ credMan: false, dpapi: true }) };
  await setToken('win-tok', deps);
  const raw = fs.readFileSync(credsPath(dir), 'utf-8');
  const obj = JSON.parse(raw);
  assert.ok(obj.enc, 'ciphertext stored under "enc"');
  assert.equal(obj.token, undefined, 'no plaintext token field');
  assert.ok(!raw.includes('win-tok'), 'plaintext token absent from file');
  assert.equal(await getToken(deps), 'win-tok', 'decrypts on read');
});

test('Windows — Credential Manager + DPAPI unavailable → plaintext 0600 file fallback', async (t) => {
  const dir = tmpHome(t);
  const deps = { platform: 'win32', run: winRun({ credMan: false, dpapi: false }) };
  await setToken('win-plain', deps);
  assert.equal(JSON.parse(fs.readFileSync(credsPath(dir), 'utf-8')).token, 'win-plain');
  assert.equal(await getToken(deps), 'win-plain');
});

test('Windows — legacy DPAPI-file token still read when Credential Manager is empty', async (t) => {
  tmpHome(t);
  // Simulate a user who linked before the Credential Manager backend existed: token lives in
  // the DPAPI file only. A later session (credMan present but empty) must still find it.
  await setToken('legacy-dpapi', { platform: 'win32', run: winRun({ credMan: false, dpapi: true }) });
  assert.equal(await getToken({ platform: 'win32', run: winRun({ credMan: true, dpapi: true }) }), 'legacy-dpapi');
});

// ── cross-cutting ────────────────────────────────────────────────────────────────

test('unknown platform → file store round-trip', async (t) => {
  const dir = tmpHome(t);
  const deps = { platform: 'sunos', run: () => ({ ok: false, stdout: '' }) };
  await setToken('generic', deps);
  assert.equal(fs.existsSync(credsPath(dir)), true);
  assert.equal(await getToken(deps), 'generic');
});

test('keychain empty but a file token exists → file fallback on read', async (t) => {
  tmpHome(t);
  await setToken('legacy-file', { platform: 'sunos', run: () => ({ ok: false, stdout: '' }) }); // file
  const deps = { platform: 'darwin', run: macRun(new Map()) };                                   // empty keychain
  assert.equal(await getToken(deps), 'legacy-file');
});

test('no token anywhere → null, never throws', async (t) => {
  tmpHome(t);
  const deps = { platform: 'darwin', run: macRun(new Map()) };
  await assert.doesNotReject(() => getToken(deps));
  assert.equal(await getToken(deps), null);
});

test('deleteToken clears both keychain and any file token', async (t) => {
  const dir = tmpHome(t);
  // Seed a stale file token AND a keychain token.
  await setToken('file-one', { platform: 'sunos', run: () => ({ ok: false, stdout: '' }) });
  const store = new Map();
  const deps = { platform: 'darwin', run: macRun(store) };
  await setToken('key-one', deps);
  await deleteToken(deps);
  assert.equal(store.has('k'), false, 'keychain cleared');
  assert.equal(fs.existsSync(credsPath(dir)), false, 'file cleared');
  assert.equal(await getToken(deps), null);
});

test('file store uses restricted 0600 permissions (posix only)', { skip: process.platform === 'win32' }, async (t) => {
  const dir = tmpHome(t);
  await setToken('x', { platform: 'linux', run: secretToolRun(new Map(), false) });
  const mode = fs.statSync(credsPath(dir)).mode & 0o777;
  assert.equal(mode, 0o600);
});
