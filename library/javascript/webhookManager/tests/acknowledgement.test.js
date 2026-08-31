import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import WebhookManager from '../WebhookManager.js';

class FakeResponse extends EventEmitter {
  constructor(sequence) {
    super();
    this.sequence = sequence;
    this.statusCode = null;
    this.body = null;
  }

  status(code) {
    this.statusCode = code;
    this.sequence.push(`status:${code}`);
    return this;
  }

  end() {
    this.sequence.push('end');
    this.emit('finish');
    return this;
  }

  json(body) {
    this.statusCode = this.statusCode || 200;
    this.body = body;
    this.sequence.push('json');
    this.emit('finish');
    return this;
  }

  sendStatus(code) {
    this.statusCode = code;
    this.sequence.push(`sendStatus:${code}`);
    this.emit('finish');
    return this;
  }
}

function createLogger(sequence) {
  return {
    log: () => sequence.push('log'),
    info: () => sequence.push('info'),
    warn: () => sequence.push('warn'),
    error: () => sequence.push('error'),
  };
}

function signedRequest(body, secret = 'secret', timestamp = String(Math.floor(Date.now() / 1000))) {
  const rawBody = Buffer.from(JSON.stringify(body));
  const hash = crypto
    .createHmac('sha256', secret)
    .update(`v0:${timestamp}:${rawBody.toString('utf8')}`)
    .digest('hex');
  return {
    headers: {
      'x-zm-request-id': 'request-id',
      'x-zm-request-timestamp': timestamp,
      'x-zm-signature': `v0=${hash}`,
    },
    rawBody,
    body,
    query: {},
  };
}

test('normal webhook is acknowledged before logging and event emission', async () => {
  const sequence = [];
  const manager = new WebhookManager({
    logger: createLogger(sequence),
    config: { webhookPath: '/webhook', zoomSecretToken: 'secret' },
  });
  const response = new FakeResponse(sequence);
  manager.on('event', () => sequence.push('emit'));

  await manager.handleWebhook(signedRequest({
    event: 'meeting.rtms_started',
    payload: { rtms_stream_id: 'stream-id' },
  }), response);

  assert.deepEqual(sequence, ['status:200', 'end']);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(response.statusCode, 200);
  assert.ok(sequence.indexOf('log') > sequence.indexOf('end'));
  assert.ok(sequence.indexOf('emit') > sequence.indexOf('end'));
});

test('normal webhook with an invalid signature is rejected before processing', async () => {
  const sequence = [];
  const manager = new WebhookManager({
    logger: createLogger(sequence),
    config: { webhookPath: '/webhook', zoomSecretToken: 'secret' },
  });
  const response = new FakeResponse(sequence);
  let emitted = false;
  manager.on('event', () => { emitted = true; });
  const request = signedRequest({
    event: 'meeting.rtms_started',
    payload: { rtms_stream_id: 'stream-id' },
  }, 'wrong-secret');

  await manager.handleWebhook(request, response);

  assert.equal(response.statusCode, 401);
  assert.equal(emitted, false);
});

test('normal webhook with a stale timestamp is rejected', async () => {
  const sequence = [];
  const manager = new WebhookManager({
    logger: createLogger(sequence),
    config: { webhookPath: '/webhook', zoomSecretToken: 'secret' },
  });
  const response = new FakeResponse(sequence);
  const staleTimestamp = String(Math.floor(Date.now() / 1000) - 301);

  await manager.handleWebhook(signedRequest({
    event: 'meeting.rtms_started',
    payload: { rtms_stream_id: 'stream-id' },
  }, 'secret', staleTimestamp), response);

  assert.equal(response.statusCode, 401);
});

test('URL validation returns its required JSON response', async () => {
  const sequence = [];
  const manager = new WebhookManager({
    logger: createLogger(sequence),
    config: { webhookPath: '/webhook', zoomSecretToken: 'secret' },
  });
  const response = new FakeResponse(sequence);

  await manager.handleWebhook({
    headers: {},
    body: {
      event: 'endpoint.url_validation',
      payload: { plainToken: 'plain-token' },
    },
    query: {},
  }, response);

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.plainToken, 'plain-token');
  assert.match(response.body.encryptedToken, /^[a-f0-9]{64}$/);
  assert.ok(sequence.includes('json'));
  assert.ok(!sequence.includes('end'));
});
