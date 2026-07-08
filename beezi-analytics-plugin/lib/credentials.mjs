import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { credentialsFile } from './paths.mjs';
import { readJson, writeJsonSecure } from './fs-store.mjs';

const SERVICE = 'beezi-analytics';
const ACCOUNT = 'token';

// Absolute path to PowerShell — never a bare name. On Windows a bare `powershell.exe`
// is resolved against the child's current directory first, so an attacker file dropped
// in a repo the user opens could be executed (and would receive the plaintext token on
// stdin). Pinning the system path closes that hijack.
const POWERSHELL = process.env.SystemRoot
  ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : 'powershell.exe';

// Run a command with no shell (argv array), optional stdin. Never throws — returns
// { ok, stdout } so callers can fall back to the file store on any failure.
function defaultRun(file, args, input) {
  try {
    const stdout = execFileSync(file, args, {
      input: input ?? undefined,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
      // Bound the spawn: a locked keychain / hung helper must not block the hook.
      timeout: 5000,
      killSignal: 'SIGKILL',
    });
    return { ok: true, stdout: stdout ?? '' };
  } catch {
    return { ok: false, stdout: '' };
  }
}

// Turn a run() result into a trimmed token, or null.
function tokenFrom(r) {
  const t = r.ok ? r.stdout.trim() : '';
  return t || null;
}

// ── file store: the always-available fallback, and where the Windows DPAPI
//    ciphertext is kept (0600; on Windows the user profile ACL also applies). ──

function fileRead() {
  return readJson(credentialsFile());
}

function fileWrite(obj) {
  writeJsonSecure(credentialsFile(), obj);
}

function fileDelete() {
  try { fs.unlinkSync(credentialsFile()); } catch { /* already absent */ }
}

// ── backends. Each: { available(), get() -> string|null, set(token) -> boolean, delete() }.

function macBackend(run) {
  return {
    available: () => true, // `security` ships with macOS
    get() {
      return tokenFrom(run('security', ['find-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-w']));
    },
    set(token) {
      return run('security', ['add-generic-password', '-U', '-s', SERVICE, '-a', ACCOUNT, '-w', token]).ok
        ? 'the macOS keychain' : false;
    },
    delete() {
      run('security', ['delete-generic-password', '-s', SERVICE, '-a', ACCOUNT]);
    },
  };
}

function secretToolBackend(run) {
  const attrs = ['service', SERVICE, 'account', ACCOUNT];
  return {
    available: () => run('secret-tool', ['--version']).ok, // libsecret often absent
    get() {
      return tokenFrom(run('secret-tool', ['lookup', ...attrs]));
    },
    set(token) {
      // secret-tool reads the secret from stdin — keeps it out of the process list.
      return run('secret-tool', ['store', '--label=beezi-analytics', ...attrs], token).ok
        ? 'the OS secret service (libsecret)' : false;
    },
    delete() {
      run('secret-tool', ['clear', ...attrs]);
    },
  };
}

// Windows Credential Manager can store but not return a secret from the CLI, so we use
// DPAPI (user-bound OS crypto) via PowerShell and keep the ciphertext in the 0600 file.
const DPAPI_ENC = "$in=[Console]::In.ReadToEnd();Add-Type -AssemblyName System.Security;"
  + "$b=[Text.Encoding]::UTF8.GetBytes($in);"
  + "$e=[Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser');"
  + '[Convert]::ToBase64String($e)';
const DPAPI_DEC = "$in=[Console]::In.ReadToEnd().Trim();Add-Type -AssemblyName System.Security;"
  + "$b=[Convert]::FromBase64String($in);"
  + "$d=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser');"
  + '[Text.Encoding]::UTF8.GetString($d)';

function powershell(run, script, input) {
  return run(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', script], input);
}

function dpapiFileBackend(run) {
  return {
    available: () => true, // PowerShell ships with Windows; DPAPI failures fall back below
    get() {
      const obj = fileRead();
      if (!obj) return null;
      if (typeof obj.enc === 'string') return tokenFrom(powershell(run, DPAPI_DEC, obj.enc));
      return typeof obj.token === 'string' ? obj.token : null; // plaintext (DPAPI was down at set)
    },
    set(token) {
      const r = powershell(run, DPAPI_ENC, token);
      if (r.ok && r.stdout.trim()) { fileWrite({ enc: r.stdout.trim() }); return 'Windows DPAPI (encrypted at rest)'; }
      fileWrite({ token }); // DPAPI unavailable → plaintext, still 0600
      return 'a restricted local file';
    },
    delete: fileDelete,
  };
}

function fileBackend() {
  return {
    available: () => true,
    get() {
      const obj = fileRead();
      return obj && typeof obj.token === 'string' ? obj.token : null;
    },
    set(token) { fileWrite({ token }); return 'a restricted local file'; },
    delete: fileDelete,
  };
}

// Preferred backend chain for the platform; the plaintext file is always the tail.
function backends(deps) {
  const run = deps.run ?? defaultRun;
  const platform = deps.platform ?? process.platform;
  const file = fileBackend();
  if (platform === 'darwin') return [macBackend(run), file];
  if (platform === 'linux') return [secretToolBackend(run), file];
  if (platform === 'win32') return [dpapiFileBackend(run), file];
  return [file];
}

export async function getToken(deps = {}) {
  for (const b of backends(deps)) {
    if (!b.available()) continue;
    const t = b.get();
    if (t) return t;
  }
  return null;
}

// Returns a human-readable description of where the token was actually stored, so the
// caller can report accurately (keychain vs a local file) instead of always claiming
// the keychain.
export async function setToken(token, deps = {}) {
  for (const b of backends(deps)) {
    if (!b.available()) continue;
    const where = b.set(token);
    if (where) return where;
  }
  return 'a restricted local file';
}

export async function deleteToken(deps = {}) {
  // Clear every backend that could hold it (keychain + file), best-effort.
  for (const b of backends(deps)) {
    if (b.available()) { try { b.delete(); } catch { /* ignore */ } }
  }
}
