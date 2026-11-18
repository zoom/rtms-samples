import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildUrlValidationResponse,
  normalizeWebhookPlainToken,
  verifyZoomWebhookRequest
} from '../zoomWebhookSignature.js';

const SECRET = 'test-secret';

test('normalizeWebhookPlainToken accepts reasonable Zoom tokens', () => {
  assert.equal(normalizeWebhookPlainToken('abc123XYZ'), 'abc123XYZ');
  assert.equal(normalizeWebhookPlainToken('v0:123:body'), 'v0:123:body');
});

test('normalizeWebhookPlainToken rejects malformed tokens', () => {
  assert.equal(normalizeWebhookPlainToken(undefined), null);
  assert.equal(normalizeWebhookPlainToken(123), null);
  assert.equal(normalizeWebhookPlainToken('short'), null);
  assert.equal(normalizeWebhookPlainToken('x'.repeat(257)), null);
  assert.equal(normalizeWebhookPlainToken('has space'), null);
});

test('buildUrlValidationResponse validates and echoes the token', () => {
  const response = buildUrlValidationResponse('abc123XYZ', SECRET);
  assert.equal(response.plainToken, 'abc123XYZ');
  assert.match(response.encryptedToken, /^[a-f0-9]{64}$/);
  assert.throws(() => buildUrlValidationResponse('bad token with space', SECRET), /invalid_plain_token/);
  assert.throws(() => buildUrlValidationResponse('abc123XYZ', ''), /missing_webhook_secret_token/);
});

test('verifyZoomWebhookRequest accepts a signature derived from url validation', () => {
  const ts = String(Math.floor(Date.now() / 1000));
  const body = JSON.stringify({ event: 'meeting.rtms_stopped', payload: {} });
  const message = `v0:${ts}:${body}`;
  const { encryptedToken } = buildUrlValidationResponse(message, SECRET);
    const verdict = verifyZoomWebhookRequest(
    { headers: { 'x-zm-signature': `v0=${encryptedToken}`, 'x-zm-request-timestamp': ts }, rawBody: Buffer.from(body) },
    SECRET
  );
  assert.equal(verdict.ok, true);
});
