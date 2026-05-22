import fetch from 'node-fetch';
import {
  buildDummyRtmsWebhook,
  parseArgs,
  signZoomWebhook
} from './dummyRtms.js';

const args = parseArgs(process.argv.slice(2));
const hubUrl = args.hubUrl || process.env.WEBHOOK_TEST_URL || 'http://127.0.0.1:4400/webhook';
const dispatcherHealthUrl = args.dispatcherHealthUrl || process.env.DISPATCHER_HEALTH_URL || 'http://127.0.0.1:4050/health';
const secret = args.secret || process.env.WEBHOOK_TEST_SECRET || process.env.ZOOM_SECRET_TOKEN || 'testsecrettoken';
const timeoutMs = Number(args.timeoutMs || 5000);
const pollIntervalMs = Number(args.pollIntervalMs || 200);

const spokeChecks = [
  { code: 'SJC', spoke: 'amer-west', eventsUrl: 'http://127.0.0.1:4610/local/events' },
  { code: 'IAD', spoke: 'amer-east', eventsUrl: 'http://127.0.0.1:4611/local/events' },
  { code: 'FRA', spoke: 'europe', eventsUrl: 'http://127.0.0.1:4612/local/events' },
  { code: 'NRT', spoke: 'apac-hub', eventsUrl: 'http://127.0.0.1:4613/local/events' },
  { code: 'LHR', spoke: 'us-fallback', eventsUrl: 'http://127.0.0.1:4611/local/events' }
];

const results = [];

await testHubHealth();
await testDispatcherHealth();

for (const check of spokeChecks) {
  await testRoute(check);
}

const failed = results.filter((result) => !result.ok);
for (const result of results) {
  const marker = result.ok ? 'PASS' : 'FAIL';
  const name = result.name || `route_${result.code}_to_${result.spoke}`;
  console.log(`${marker} ${name} status=${result.status}${result.reason ? ` reason=${result.reason}` : ''}`);
}

if (failed.length > 0) {
  console.error(`02 routing tester failed: ${failed.length}/${results.length}`);
  process.exit(1);
}

console.log(`02 routing tester passed: ${results.length}/${results.length}`);

async function testHubHealth() {
  const healthUrl = new URL('/health', hubUrl).toString();
  const response = await fetch(healthUrl);
  const body = await readJson(response);
  results.push({
    name: 'hub_sqlite_health',
    code: 'hub',
    spoke: 'sqlite-health',
    status: response.status,
    ok: response.status === 200 &&
      body?.ok === true &&
      body?.sqlite?.journalMode === 'wal' &&
      Number(body?.idempotency?.ttlMs || 0) >= 3900000,
    reason: body?.sqlite?.journalMode
  });
}

async function testDispatcherHealth() {
  const response = await fetch(dispatcherHealthUrl);
  const body = await readJson(response);
  results.push({
    name: 'dispatcher_sqlite_and_signing_health',
    code: 'dispatcher',
    spoke: 'sqlite-routing-health',
    status: response.status,
    ok: response.status === 200 &&
      body?.ok === true &&
      body?.sqlite?.journalMode === 'wal' &&
      body?.spokeGroupByCode?.SJC === 'amer-west' &&
      body?.spokeGroupByCode?.IAD === 'amer-east' &&
      body?.spokeRequestSigning === 'enabled',
    reason: body?.spokeRequestSigning || body?.sqlite?.journalMode
  });
}

async function testRoute(check) {
  const streamId = `test02-${check.code.toLowerCase()}-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  const webhook = buildDummyRtmsWebhook({
    event: 'meeting.rtms_started',
    region: check.code,
    streamId,
    eventTs: Date.now()
  });

  const response = await postSignedWebhook(webhook);
  if (response.status !== 204) {
    const text = await response.text();
    results.push({
      ...check,
      status: response.status,
      ok: false,
      reason: text || 'hub_rejected'
    });
    return;
  }

  const seen = await waitForSpokeEvent(check.eventsUrl, streamId, check.code);
  results.push({
    ...check,
    status: response.status,
    ok: seen,
    reason: seen ? undefined : `stream_not_seen_at_${check.eventsUrl}`
  });

  if (seen) {
    await testRecoveryRoute(check, streamId, webhook.payload.meeting_uuid);
  }
}

async function testRecoveryRoute(check, streamId, rtmsId) {
  const recoveryWebhook = buildDummyRtmsWebhook({
    event: 'meeting.rtms_interrupted',
    streamId,
    rtmsId,
    eventTs: Date.now()
  });

  const response = await postSignedWebhook(recoveryWebhook);
  const seen = response.status === 204 &&
    await waitForSpokeEvent(check.eventsUrl, streamId, null, 'meeting.rtms_interrupted');

  results.push({
    name: `recovery_route_${check.code}_to_${check.spoke}`,
    code: check.code,
    spoke: check.spoke,
    status: response.status,
    ok: seen,
    reason: seen ? undefined : `recovery_not_seen_at_${check.eventsUrl}`
  });
}

async function postSignedWebhook(body) {
  const bodyText = JSON.stringify(body);
  const signed = signZoomWebhook(bodyText, secret);

  return fetch(hubUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-zm-request-timestamp': signed.timestamp,
      'x-zm-signature': signed.signature
    },
    body: bodyText
  });
}

async function waitForSpokeEvent(eventsUrl, streamId, code, expectedEvent = null) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(eventsUrl);
      const body = await response.json();
      const found = Array.isArray(body.events) && body.events.some((event) => (
        event.streamId === streamId &&
        (!code || String(event.regionCode || '').toUpperCase() === code) &&
        (!expectedEvent || event.event === expectedEvent)
      ));
      if (found) return true;
    } catch {
      // Keep polling until timeout; the caller reports the failed route.
    }

    await sleep(pollIntervalMs);
  }

  return false;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
