import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, buildConfig } from '../lib/billing-capture.mjs';

test('parseArgs recognizes --from-claude as a boolean flag', () => {
  const a = parseArgs(['--from-claude', '--via', 'login']);
  assert.equal(a.fromClaude, true);
  assert.equal(a.via, 'login');
});

test('buildConfig — null/absent expiresAt yields null credentialsExpiresAt (not 0)', () => {
  const cfg = buildConfig(
    { subscriptionType: 'team', rateLimitTier: 'default_raven', expiresAt: null, via: 'login' },
    {},
    new Date('2026-07-07T00:00:00.000Z'),
  );
  assert.equal(cfg.credentialsExpiresAt, null);
  assert.equal(cfg.plan, 'team');
});

test('parseArgs reads the named flags', () => {
  const a = parseArgs(['--subscription-type', 'pro', '--rate-limit-tier', 'default_claude_max_5x', '--expires-at', '123', '--via', 'login']);
  assert.deepEqual(a, { subscriptionType: 'pro', rateLimitTier: 'default_claude_max_5x', expiresAt: '123', via: 'login' });
});

test('buildConfig — subscription env yields plan + raw fields', () => {
  const cfg = buildConfig(
    { subscriptionType: 'pro', rateLimitTier: 'default_claude_max_5x', expiresAt: '1754418735285', via: 'login' },
    {},
    new Date('2026-07-07T00:00:00.000Z'),
  );
  assert.equal(cfg.version, 1);
  assert.equal(cfg.source, 'subscription');
  assert.equal(cfg.subscriptionType, 'pro');
  assert.equal(cfg.rateLimitTier, 'default_claude_max_5x');
  assert.equal(cfg.plan, 'max_5x');
  assert.equal(cfg.credentialsExpiresAt, 1754418735285);
  assert.equal(cfg.capturedBy, 'login');
  assert.equal(cfg.capturedAt, '2026-07-07T00:00:00.000Z');
});

test('buildConfig — api-key env nulls the plan fields', () => {
  const cfg = buildConfig(
    { subscriptionType: 'pro', rateLimitTier: 'default_claude_max_5x', via: 'refresh' },
    { ANTHROPIC_API_KEY: 'sk-x' },
    new Date('2026-07-07T00:00:00.000Z'),
  );
  assert.equal(cfg.source, 'anthropic_api_key');
  assert.equal(cfg.subscriptionType, null);
  assert.equal(cfg.rateLimitTier, null);
  assert.equal(cfg.plan, null);
});

test('buildConfig — rejects token-shaped input', () => {
  assert.throws(() => buildConfig({ subscriptionType: 'sk-ant-oat01-secret' }, {}, new Date()));
  assert.throws(() => buildConfig({ rateLimitTier: 'x'.repeat(65) }, {}, new Date()));
});
