import { BillingSource, detectBillingSource, normalizePlan } from './billing.mjs';

// The credential fields are short opaque labels. Anything token-shaped (an
// sk-ant secret, an over-long string, or embedded whitespace) is refused so a
// misdirected value can never be persisted.
const TOKEN_LIKE = /sk-ant|\s/;

function safeField(value) {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (s.length > 64 || TOKEN_LIKE.test(s)) {
    throw new Error('Refusing a suspicious value (looks token-like). Nothing written.');
  }
  return s;
}

export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--subscription-type') out.subscriptionType = argv[++i];
    else if (flag === '--rate-limit-tier') out.rateLimitTier = argv[++i];
    else if (flag === '--expires-at') out.expiresAt = argv[++i];
    else if (flag === '--via') out.via = argv[++i];
    else if (flag === '--from-claude') out.fromClaude = true;
  }
  return out;
}

export function buildConfig(args, env = process.env, now = new Date()) {
  const subscriptionType = safeField(args.subscriptionType);
  const rateLimitTier = safeField(args.rateLimitTier);
  const via = safeField(args.via) ?? 'manual';
  const source = detectBillingSource(env);
  const isSub = source === BillingSource.SUBSCRIPTION;
  // null/undefined/'' must stay null — Number(null) is 0, which would look like an
  // already-expired timestamp and force a permanent "stale" state.
  const expiresAt = args.expiresAt == null || args.expiresAt === '' ? NaN : Number(args.expiresAt);
  return {
    version: 1,
    source,
    subscriptionType: isSub ? subscriptionType : null,
    rateLimitTier: isSub ? rateLimitTier : null,
    plan: isSub ? normalizePlan(subscriptionType, rateLimitTier) : null,
    credentialsExpiresAt: Number.isFinite(expiresAt) ? expiresAt : null,
    capturedAt: now.toISOString(),
    capturedBy: via,
  };
}
