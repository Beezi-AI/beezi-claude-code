export function apiBase() {
  return (
    process.env.BEEZI_API_URL ?? "https://beezi-api-prod.azurewebsites.net/api"
  );
}

// The Beezi REST surface, in one place. Paths are relative to apiBase().
export const ENDPOINTS = Object.freeze({
  sessionsReport: "/sessions/report",
  sessionErrors: "/sessions/errors",
  sessionsTimeline: "/sessions/timeline",
  reposStatus: "/repos/status",
  whoami: "/me/claude-code/whoami",
  deviceStart: "/auth/device/start",
  devicePoll: "/auth/device/poll",
});
