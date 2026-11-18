import assert from 'node:assert/strict';
import test from 'node:test';

import { isAllowedRtmsCallbackUrl } from '../utils/rtmsUrlPolicy.js';

test('accepts zoom.us wss endpoints', () => {
  assert.equal(isAllowedRtmsCallbackUrl('wss://rwcpdns1sjc.zoom.us/ws'), true);
  assert.equal(isAllowedRtmsCallbackUrl('wss://zoom.us/ws'), true);
});

test('rejects malformed or non-zoom hosts', () => {
  assert.equal(isAllowedRtmsCallbackUrl('http://169.254.169.254/'), false);
  assert.equal(isAllowedRtmsCallbackUrl('wss://evil.example.com/ws'), false);
  assert.equal(isAllowedRtmsCallbackUrl('not a url'), false);
  assert.equal(isAllowedRtmsCallbackUrl(''), false);
});

test('honors custom allowlists', () => {
  assert.equal(isAllowedRtmsCallbackUrl('wss://media.corp.internal/ws', ['corp.internal']), true);
  assert.equal(isAllowedRtmsCallbackUrl('wss://media.corp.internal/ws', ['other.internal']), false);
});
