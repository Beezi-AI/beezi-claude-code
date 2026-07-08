export function apiBase() {
  return process.env.BEEZI_API_URL ?? 'https://api.beezi.example';
}

// The Beezi REST surface, in one place. Paths are relative to apiBase().
export const ENDPOINTS = Object.freeze({
  sessionsReport: '/sessions/report',
  sessionErrors: '/sessions/errors',
  reposStatus: '/repos/status',
  whoami: '/me/claude-code/whoami',
  deviceStart: '/auth/device/start',
  devicePoll: '/auth/device/poll',
});
