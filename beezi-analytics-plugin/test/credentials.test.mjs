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

// DPAPI faked as reversible base64 so enc/dec round-trips.
function powershellRun(works) {
  return (file, args, input) => {
    // The backend invokes PowerShell by absolute path; match on the basename.
    if (path.basename(String(file)).toLowerCase() !== 'powershell.exe') return { ok: false, stdout: '' };
    if (!works) return { ok: false, stdout: '' };
    const script = args[args.indexOf('-Command') + 1];
    // Note: 'Unprotect'.includes('Protect') is true — check Unprotect FIRST.
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

test('Windows — DPAPI encrypts at rest (no plaintext token in the file)', async (t) => {
  const dir = tmpHome(t);
  const deps = { platform: 'win32', run: powershellRun(true) };
  await setToken('win-tok', deps);
  const raw = fs.readFileSync(credsPath(dir), 'utf-8');
  const obj = JSON.parse(raw);
  assert.ok(obj.enc, 'ciphertext stored under "enc"');
  assert.equal(obj.token, undefined, 'no plaintext token field');
  assert.ok(!raw.includes('win-tok'), 'plaintext token absent from file');
  assert.equal(await getToken(deps), 'win-tok', 'decrypts on read');
});

test('Windows — DPAPI unavailable → plaintext 0600 file fallback', async (t) => {
  const dir = tmpHome(t);
  const deps = { platform: 'win32', run: powershellRun(false) };
  await setToken('win-plain', deps);
  assert.equal(JSON.parse(fs.readFileSync(credsPath(dir), 'utf-8')).token, 'win-plain');
  assert.equal(await getToken(deps), 'win-plain');
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
