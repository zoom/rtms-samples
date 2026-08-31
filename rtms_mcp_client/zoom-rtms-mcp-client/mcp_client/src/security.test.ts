import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { TranscriptBatcher } from './transcriptBatcher.js';
import { isWebhookTenantAuthorized, verifyZoomWebhook } from './webhookSecurity.js';

test('authenticates the exact Zoom webhook body and rejects stale requests', () => {
  const body = Buffer.from('{"event":"meeting.rtms_started"}');
  const timestamp = '1000';
  const signature = `v0=${crypto.createHmac('sha256', 'secret').update(`v0:${timestamp}:${body}`).digest('hex')}`;
  const headers = { 'x-zm-signature': signature, 'x-zm-request-timestamp': timestamp };
  assert.equal(verifyZoomWebhook(headers, body, 'secret', 300, 1001), true);
  assert.equal(verifyZoomWebhook(headers, body, 'wrong', 300, 1001), false);
  assert.equal(verifyZoomWebhook(headers, body, 'secret', 300, 1400), false);
});

test('authorizes stop events only when an authorized stream is already known', () => {
  assert.equal(isWebhookTenantAuthorized('meeting.rtms_started', { account_id: 'account-a' }, 'account-a', false), true);
  assert.equal(isWebhookTenantAuthorized('meeting.rtms_started', { account_id: 'account-b' }, 'account-a', false), false);
  assert.equal(isWebhookTenantAuthorized('meeting.rtms_stopped', {}, 'account-a', true), true);
  assert.equal(isWebhookTenantAuthorized('meeting.rtms_stopped', {}, 'account-a', false), false);
});

test('isolates transcript batches by stream', async () => {
  const flushed = new Map<string, string>();
  const batcher = new TranscriptBatcher({
    windowMs: 1000,
    maxCharacters: 100,
    onFlush: async (streamId, text) => { flushed.set(streamId, text); }
  });
  batcher.add('stream-a', 'hello');
  batcher.add('stream-b', 'separate');
  batcher.add('stream-a', 'world');
  await Promise.all([batcher.flush('stream-a'), batcher.flush('stream-b')]);
  assert.equal(flushed.get('stream-a'), 'hello world');
  assert.equal(flushed.get('stream-b'), 'separate');
});
