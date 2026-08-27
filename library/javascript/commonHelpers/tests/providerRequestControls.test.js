import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ProviderRequestControls,
  sanitizeProviderError
} from '../providerRequestControls.js';

function controls(overrides = {}) {
  return new ProviderRequestControls({
    provider: 'TestProvider',
    maxInputCharacters: 100,
    maxRequestsPerMinute: 2,
    maxRequestsPerStream: 2,
    maxSpendUsdPerStream: 1,
    inputCostPerMillionTokens: 1,
    outputCostPerMillionTokens: 1,
    ...overrides
  });
}

test('enforces process rate and stream request limits', () => {
  const rateLimiter = controls();
  rateLimiter.reserve('stream-1', 'hello', 10);
  rateLimiter.reserve('stream-2', 'hello', 10);
  assert.throws(() => rateLimiter.reserve('stream-3', 'hello', 10), { code: 'local_rate_limit' });

  const streamLimiter = controls({ maxRequestsPerMinute: 10 });
  streamLimiter.reserve('stream-1', 'hello', 10);
  streamLimiter.reserve('stream-1', 'hello', 10);
  assert.throws(() => streamLimiter.reserve('stream-1', 'hello', 10), { code: 'stream_request_limit' });
});

test('reserves estimated spend before concurrent requests complete', () => {
  const limiter = controls({ maxRequestsPerMinute: 10, maxSpendUsdPerStream: 0.00002 });
  limiter.reserve('stream-1', '1234567890', 10);
  assert.throws(() => limiter.reserve('stream-1', '1234567890', 10), { code: 'stream_spend_limit' });
});

test('sanitizes authentication failures without provider response bodies', () => {
  assert.deepEqual(sanitizeProviderError('OpenAI', {
    status: 401,
    message: 'secret response body'
  }), {
    provider: 'OpenAI',
    code: 'authentication_failed',
    message: 'OpenAI rejected the API credentials.',
    action: 'Verify the OpenAI API key configured for this service.',
    retryable: false,
    status: 401
  });
});
