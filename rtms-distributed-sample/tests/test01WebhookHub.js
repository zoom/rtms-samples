import crypto from 'crypto';
import fetch from 'node-fetch';
import {
  buildDummyRtmsWebhook,
  parseArgs,
  signZoomWebhook
} from './dummyRtms.js';

const args = parseArgs(process.argv.slice(2));
const target = args.target || process.env.WEBHOOK_TEST_URL || 'http://127.0.0.1:4400/webhook';
const secret = args.secret || process.env.WEBHOOK_TEST_SECRET || process.env.ZOOM_SECRET_TOKEN || 'testsecrettoken';
const wrongSecret = args.wrongSecret || 'wrongsecret';
const staleSeconds = Number(args.staleSeconds || 1000);

const results = [];

await testHealth();
await testUrlValidation();
await testValidSignedWebhook();
await testDuplicateRtmsWebhook();
await testInvalidSignature();
await testStaleTimestamp();
await testMalformedPayload();

const failed = results.filter((result) => !result.ok);

for (const result of results) {
  const marker = result.ok ? 'PASS' : 'FAIL';
  console.log(`${marker} ${result.name} status=${result.status}${result.reason ? ` reason=${result.reason}` : ''}`);
}

if (failed.length > 0) {
  console.error(`01 webhook hub tester failed: ${failed.length}/${results.length}`);
  process.exit(1);
}

console.log(`01 webhook hub tester passed: ${results.length}/${results.length}`);

async function testHealth() {
  const healthUrl = new URL('/health', target).toString();
  const response = await fetch(healthUrl);
  const body = await readJson(response);

  record({
    name: 'health',
    status: response.status,
    ok: response.status === 200 && body?.ok === true && body?.service === 'centralized-webhook-hub'
  });
}

async function testUrlValidation() {
  const plainToken = `plain-${Date.now()}`;
  const response = await postJson(target, {
    event: 'endpoint.url_validation',
    payload: { plainToken }
  });
  const body = await readJson(response);
  const expectedEncryptedToken = crypto
    .createHmac('sha256', secret)
    .update(plainToken)
    .digest('hex');

  record({
    name: 'url_validation',
    status: response.status,
    ok: response.status === 200 &&
      body?.plainToken === plainToken &&
      body?.encryptedToken === expectedEncryptedToken
  });
}

async function testValidSignedWebhook() {
  const body = buildDummyRtmsWebhook({
    event: 'meeting.rtms_started',
    region: 'IAD',
    streamId: `test01-valid-${Date.now()}`
  });
  const response = await postSignedWebhook(body, secret);

  record({
    name: 'valid_signed_webhook',
    status: response.status,
    ok: response.status === 204
  });
}

async function testInvalidSignature() {
  const body = buildDummyRtmsWebhook({
    event: 'meeting.rtms_started',
    region: 'IAD',
    streamId: `test01-invalid-signature-${Date.now()}`
  });
  const response = await postSignedWebhook(body, wrongSecret);
  const responseBody = await readJson(response);

  record({
    name: 'invalid_signature_rejected',
    status: response.status,
    reason: responseBody?.reason,
    ok: response.status === 401 && responseBody?.reason === 'invalid_x_zm_signature'
  });
}

async function testDuplicateRtmsWebhook() {
  const body = buildDummyRtmsWebhook({
    event: 'meeting.rtms_started',
    region: 'IAD',
    streamId: `test01-duplicate-${Date.now()}`,
    eventTs: Date.now()
  });

  const firstResponse = await postSignedWebhook(body, secret);
  const secondResponse = await postSignedWebhook(body, secret);

  record({
    name: 'duplicate_rtms_webhook_dropped',
    status: secondResponse.status,
    reason: secondResponse.headers.get('x-rtms-duplicate') || undefined,
    ok: firstResponse.status === 204 &&
      secondResponse.status === 204 &&
      secondResponse.headers.get('x-rtms-duplicate') === 'true'
  });
}

async function testStaleTimestamp() {
  const body = buildDummyRtmsWebhook({
    event: 'meeting.rtms_started',
    region: 'IAD',
    streamId: `test01-stale-${Date.now()}`
  });
  const staleTimestamp = Math.floor(Date.now() / 1000) - staleSeconds;
  const response = await postSignedWebhook(body, secret, staleTimestamp);
  const responseBody = await readJson(response);

  record({
    name: 'stale_timestamp_rejected',
    status: response.status,
    reason: responseBody?.reason,
    ok: response.status === 401 && responseBody?.reason === 'stale_x_zm_request_timestamp'
  });
}

async function testMalformedPayload() {
  const response = await postJson(target, { hello: 'world' });
  const body = await readJson(response);

  record({
    name: 'malformed_payload_rejected',
    status: response.status,
    reason: body?.error,
    ok: response.status === 400 && body?.error === 'missing_event_or_payload'
  });
}

async function postSignedWebhook(body, signingSecret, timestamp) {
  const bodyText = JSON.stringify(body);
  const signed = signZoomWebhook(bodyText, signingSecret, timestamp);

  return fetch(target, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-zm-request-timestamp': signed.timestamp,
      'x-zm-signature': signed.signature
    },
    body: bodyText
  });
}

async function postJson(url, body) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function record(result) {
  results.push(result);
}
