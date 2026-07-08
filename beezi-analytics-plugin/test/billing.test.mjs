import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectBillingSource } from '../lib/billing.mjs';
import { normalizePlan } from '../lib/billing.mjs';

test('detectBillingSource — third_party when ANTHROPIC_BASE_URL is set', () => {
  assert.equal(detectBillingSource({ ANTHROPIC_BASE_URL: 'https://proxy.example' }), 'third_party');
});

test('detectBillingSource — third_party for Bedrock / Vertex', () => {
  assert.equal(detectBillingSource({ CLAUDE_CODE_USE_BEDROCK: '1' }), 'third_party');
  assert.equal(detectBillingSource({ CLAUDE_CODE_USE_VERTEX: '1' }), 'third_party');
});

test('detectBillingSource — third_party wins over ANTHROPIC_API_KEY', () => {
  assert.equal(
    detectBillingSource({ ANTHROPIC_BASE_URL: 'https://proxy.example', ANTHROPIC_API_KEY: 'x' }),
    'third_party',
  );
});

test('detectBillingSource — anthropic_api_key when only the key is present', () => {
  assert.equal(detectBillingSource({ ANTHROPIC_API_KEY: 'sk-x' }), 'anthropic_api_key');
});

test('detectBillingSource — subscription when nothing is set', () => {
  assert.equal(detectBillingSource({}), 'subscription');
});

test('detectBillingSource — third_party for Foundry', () => {
  assert.equal(detectBillingSource({ CLAUDE_CODE_USE_FOUNDRY: '1' }), 'third_party');
});

test('detectBillingSource — third_party for ANTHROPIC_AUTH_TOKEN (gateway)', () => {
  assert.equal(detectBillingSource({ ANTHROPIC_AUTH_TOKEN: 'tok' }), 'third_party');
});

test('detectBillingSource — subscription for CLAUDE_CODE_OAUTH_TOKEN', () => {
  assert.equal(detectBillingSource({ CLAUDE_CODE_OAUTH_TOKEN: 'oat' }), 'subscription');
});

test('normalizePlan — rateLimitTier wins for the multiplier', () => {
  assert.equal(normalizePlan('pro', 'default_claude_max_5x'), 'max_5x');
  assert.equal(normalizePlan('max', 'default_claude_max_20x'), 'max_20x');
});

test('normalizePlan — falls back to subscriptionType', () => {
  assert.equal(normalizePlan('pro', undefined), 'pro');
  assert.equal(normalizePlan('team', null), 'team');
  assert.equal(normalizePlan('enterprise', ''), 'enterprise');
  assert.equal(normalizePlan('max', 'weird_tier'), 'max');
  assert.equal(normalizePlan('free', undefined), 'free');
});

test('normalizePlan — unknown when nothing matches', () => {
  assert.equal(normalizePlan(undefined, undefined), 'unknown');
  assert.equal(normalizePlan('mystery', 'mystery'), 'unknown');
});
