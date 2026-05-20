import fetch from 'node-fetch';
import {
  parseArgs,
  signInternalWebhook
} from './dummyRtms.js';

const args = parseArgs(process.argv.slice(2));
const spokeUrl = args.spokeUrl || process.env.SPOKE_TEST_URL || 'http://127.0.0.1:4611/spoke/webhook';
const eventsUrl = args.eventsUrl || process.env.SPOKE_EVENTS_URL || 'http://127.0.0.1:4611/local/events';
const secret = args.secret || process.env.INTERNAL_WEBHOOK_TEST_SECRET || process.env.INTERNAL_WEBHOOK_SECRET || 'testsecrettoken';
const wrongSecret = args.wrongSecret || 'wronginternalsecret';
const timeoutMs = Number(args.timeoutMs || 5000);
const pollIntervalMs = Number(args.pollIntervalMs || 200);
const staleSeconds = Number(args.staleSeconds || 1000);

const results = [];

await testSpokeHealth();
await testMissingSignatureRejected();
await testInvalidSignatureRejected();
await testStaleSignatureRejected();
await testValidSignedEnvelopeAccepted();

const failed = results.filter((result) => !result.ok);
for (const result of results) {
  const marker = result.ok ? 'PASS' : 'FAIL';
  console.log(`${marker} ${result.name} status=${result.status}${result.reason ? ` reason=${result.reason}` : ''}`);
}

if (failed.length > 0) {
  console.error(`03 regional spoke security tester failed: ${failed.length}/${results.length}`);
  process.exit(1);
}

console.log(`03 regional spoke security tester passed: ${results.length}/${results.length}`);

async function testSpokeHealth() {
  const healthUrl = new URL('/health', spokeUrl).toString();
  const response = await fetch(healthUrl);
  const body = await readJson(response);
  record({
    name: 'spoke_health_signature_required',
    status: response.status,
    ok: response.status === 200 &&
      body?.ok === true &&
      body?.service === 'regional-webhook-spoke' &&
      body?.internalSignatureVerification === 'required',
    reason: body?.internalSignatureVerification
  });
}

async function testMissingSignatureRejected() {
  const response = await postEnvelope(buildEnvelope('missing-signature'), null);
  const body = await readJson(response);
  record({
    name: 'missing_internal_signature_rejected',
    status: response.status,
    reason: body?.reason,
    ok: response.status === 401 && body?.reason === 'missing_x-rtms-signature'
  });
}

async function testInvalidSignatureRejected() {
  const response = await postEnvelope(buildEnvelope('invalid-signature'), wrongSecret);
  const body = await readJson(response);
  record({
    name: 'invalid_internal_signature_rejected',
    status: response.status,
    reason: body?.reason,
    ok: response.status === 401 && body?.reason === 'invalid_x-rtms-signature'
  });
}

async function testStaleSignatureRejected() {
  const staleTimestamp = Math.floor(Date.now() / 1000) - staleSeconds;
  const response = await postEnvelope(buildEnvelope('stale-signature'), secret, staleTimestamp);
  const body = await readJson(response);
  record({
    name: 'stale_internal_signature_rejected',
    status: response.status,
    reason: body?.reason,
    ok: response.status === 401 && body?.reason === 'stale_x-rtms-request-timestamp'
  });
}

async function testValidSignedEnvelopeAccepted() {
  const streamId = `test03-valid-${Date.now()}`;
  const envelope = buildEnvelope(streamId);
  const response = await postEnvelope(envelope, secret);
  const seen = response.status === 202 && await waitForSpokeEvent(streamId);

  record({
    name: 'valid_internal_signature_accepted',
    status: response.status,
    ok: seen,
    reason: seen ? undefined : 'stream_not_seen_at_spoke'
  });
}

async function postEnvelope(envelope, signingSecret, timestamp) {
  const bodyText = JSON.stringify(envelope);
  const headers = { 'content-type': 'application/json' };
  if (signingSecret) {
    Object.assign(headers, signInternalWebhook(bodyText, signingSecret, timestamp));
  }

  return fetch(spokeUrl, {
    method: 'POST',
    headers,
    body: bodyText
  });
}

async function waitForSpokeEvent(streamId) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(eventsUrl);
      const body = await response.json();
      const found = Array.isArray(body.events) && body.events.some((event) => event.streamId === streamId);
      if (found) return true;
    } catch {
      // Keep polling until timeout; the caller reports the failed route.
    }

    await sleep(pollIntervalMs);
  }

  return false;
}

function buildEnvelope(streamId) {
  return {
    schemaVersion: 1,
    source: 'test03',
    event: 'meeting.rtms_started',
    eventType: 'start',
    productType: 'meeting',
    rtmsId: `meeting-${streamId}`,
    streamId,
    regionCode: 'IAD',
    idempotencyKey: `test03:${streamId}`,
    receivedAt: new Date().toISOString(),
    eventTs: Date.now(),
    webhook: {
      event: 'meeting.rtms_started',
      payload: {
        meeting_uuid: `meeting-${streamId}`,
        rtms_stream_id: streamId,
        event_ts: Date.now(),
        server_urls: {
          signaling: 'wss://iad.zoom.us/rtms/signaling'
        }
      }
    },
    payload: {
      meeting_uuid: `meeting-${streamId}`,
      rtms_stream_id: streamId
    }
  };
}

function record(result) {
  results.push(result);
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
