import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createClaimRegistry } from '../shared/claims.js';
import { createMemoryTrace } from '../shared/trace.js';
import { createTenantGate } from '../shared/tenantGate.js';
import { signWebhook } from '../shared/webhookSignature.js';
import { readLiveConfig, liveMediaParams, startLiveSession } from '../60-stream-lifecycle-client/src/liveSession.js';
import { createLiveBridge } from './src/liveBridge.js';
import { createRestClient } from './src/restClient.js';
import { createStartService } from './src/service.js';

// No RTMS server is involved. A session started here points at a local port with nothing listening,
// so it keeps retrying until a webhook or the test ends it. What a live session does against Zoom
// is checked with `npm run live`.

const SECRET = 'wh-secret';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 3000, label = 'condition') {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await sleep(10); }
  throw new Error(`timed out waiting for ${label}`);
}
async function closedPort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function rig({ credentials = { clientId: 'cid', clientSecret: 'csecret' }, env = {} } = {}) {
  const url = `ws://127.0.0.1:${await closedPort()}/signaling`;
  const outputDir = mkdtempSync(path.join(tmpdir(), 'live-'));
  const { config, errors } = readLiveConfig({ RTMS_OUTPUT_DIR: outputDir, RTMS_STATS_EVERY_SEC: '0', RTMS_RECONNECT_BASE_MS: '200', RTMS_RECONNECT_CAP_MS: '200', RTMS_SAVE_TRANSCRIPT: 'true', ...env });
  assert.deepEqual(errors, []);
  const trace = createMemoryTrace();
  const claims = createClaimRegistry({ leaseMs: 60_000 });
  let service;
  const bridge = createLiveBridge({ credentials, config, trace, getService: () => service });
  const alerts = [];
  service = createStartService({
    secret: SECRET, clientId: 'cid', trace, claims, rest: createRestClient({}), media: config.media,
    gate: createTenantGate([{ tenantId: 'acme', accountIds: ['A1'], products: ['meeting'], media: ['audio', 'video', 'transcript'], consentRef: 'consent-1', policyVersion: 'p1' }]),
    onStreamReady: bridge.onStreamReady, onStreamRefresh: bridge.onStreamRefresh, onStreamStopped: bridge.onStreamStopped, onAlert: (a) => alerts.push(a)
  });
  const send = async (event, payload, eventTs) => {
    const rawBody = Buffer.from(JSON.stringify({ event, event_ts: eventTs ?? Date.now(), payload }));
    const r = service.handleWebhook({ headers: signWebhook(rawBody, SECRET), rawBody });
    await r.done;
    return r;
  };
  const started = (extra = {}) => ({ account_id: 'A1', meeting_uuid: 'M1', meeting_id: '123', rtms_stream_id: 'S1', server_urls: url, ...extra });
  return { url, outputDir, trace, claims, service, bridge, alerts, send, started, close: () => bridge.shutdown(100).catch(() => {}) };
}

test('a stop webhook ends a session, writes the manifest, releases the claim and blocks a late duplicate', async () => {
  const r = await rig();
  try {
    await r.send('meeting.rtms_started', r.started(), 1);
    await waitFor(() => r.bridge.sessions.size === 1, 3000, 'session started');
    const session = r.bridge.sessions.get('S1');
    assert.equal(r.service.snapshot().active.length, 1);

    await r.send('meeting.rtms_stopped', { account_id: 'A1', meeting_uuid: 'M1', rtms_stream_id: 'S1', stop_reason: 6 }, 2);
    const result = await session.done;
    assert.equal(result.stop.name, 'meeting_ended');
    const manifest = JSON.parse(readFileSync(result.manifestPath, 'utf8'));
    assert.deepEqual([manifest.tenant_id, manifest.stream_id, manifest.consent_ref, manifest.stream_generation], ['acme', 'S1', 'consent-1', 1]);
    assert.equal(manifest.stop.name, 'meeting_ended');
    assert.equal(manifest.participants.stream_id, 'S1');
    await waitFor(() => r.bridge.sessions.size === 0, 2000, 'session cleaned up');
    assert.equal(r.service.snapshot().active.length, 0, 'claim released');
    await r.send('meeting.rtms_started', r.started(), 3);
    assert.equal(r.trace.events.at(-1).type, 'late_duplicate_dropped');
  } finally {
    await r.close();
  }
});

test('a retried started webhook never opens a second session', async () => {
  const r = await rig();
  try {
    await r.send('meeting.rtms_started', r.started(), 1);
    await r.send('meeting.rtms_started', r.started(), 1); // identical retry: dropped by the natural key
    await r.send('meeting.rtms_started', r.started(), 9); // same stream again: a refresh, not a new stream
    assert.equal(r.bridge.sessions.size, 1);
    assert.equal(r.trace.events.filter((e) => e.type === 'stream_claimed').length, 1);
    assert.equal(r.trace.events.filter((e) => e.type === 'stream_refresh').length, 1);
  } finally {
    await r.close();
  }
});

test('a refresh applies a new URL, refuses a missing one, and an unknown stream has no session', async () => {
  const r = await rig();
  try {
    await r.send('meeting.rtms_started', r.started(), 1);
    const session = r.bridge.sessions.get('S1');
    assert.deepEqual(session.client.refresh(r.url).applied, true, 'the client had not connected yet, so a URL is applied');
    assert.deepEqual(session.client.refresh({}), { applied: false, reason: 'no_signaling_url' });
    assert.deepEqual(r.bridge.onStreamRefresh({ streamId: 'unknown' }, { serverUrls: r.url }), { applied: false, reason: 'no_session' });
  } finally {
    await r.close();
  }
});

test('missing credentials fail the hand-off, so the claim is abandoned and an alert is raised', async () => {
  const r = await rig({ credentials: { clientId: '', clientSecret: '' } });
  try {
    await r.send('meeting.rtms_started', r.started(), 1);
    assert.equal(r.bridge.sessions.size, 0);
    assert.ok(r.trace.events.some((e) => e.type === 'stream_start_failed' && /ZOOM_CLIENT_ID/.test(e.error)));
    assert.equal(r.alerts.at(-1).type, 'stream_start_failed');
    assert.equal(r.claims.size(), 0);
  } finally {
    await r.close();
  }
});

test('a webhook with no server_urls fails the hand-off the same way', async () => {
  const r = await rig();
  try {
    // The service refuses an incomplete payload before the bridge sees it.
    await r.send('meeting.rtms_started', { account_id: 'A1', meeting_uuid: 'M1', rtms_stream_id: 'S1' }, 1);
    assert.equal(r.trace.events.at(-1).reason, 'incomplete_payload');
    assert.throws(() => startLiveSession({ stream: { streamId: 'S1', envelope: {} }, credentials: { clientId: 'cid', clientSecret: 'csecret' }, config: readLiveConfig({ RTMS_OUTPUT_DIR: r.outputDir }).config, trace: r.trace }), /server_urls/);
  } finally {
    await r.close();
  }
});

test('a refused account never opens a session and the alert carries the account ID to configure', async () => {
  const r = await rig();
  try {
    await r.send('meeting.rtms_started', r.started({ account_id: 'SOMEONE_NEW' }), 1);
    assert.equal(r.bridge.sessions.size, 0);
    assert.equal(r.claims.size(), 0);
    assert.deepEqual([r.alerts.at(-1).type, r.alerts.at(-1).accountId, r.alerts.at(-1).reason], ['stream_refused', 'SOMEONE_NEW', 'unknown_account']);
  } finally {
    await r.close();
  }
});

test('shutdown closes every live session', async () => {
  const r = await rig();
  await r.send('meeting.rtms_started', r.started(), 1);
  const session = r.bridge.sessions.get('S1');
  await r.bridge.shutdown(50);
  assert.equal(session.client.finalized, true);
  await waitFor(() => r.bridge.sessions.size === 0, 2000, 'sessions cleared');
});

test('live config: defaults, overrides and mistakes', () => {
  const d = readLiveConfig({});
  assert.deepEqual([d.errors, d.config.media, d.config.bufferData, d.config.windows], [[], ['audio', 'transcript'], false, { signalingMs: 60_000, mediaMs: 30_000 }]);
  const o = readLiveConfig({ RTMS_MEDIA: 'audio,video', RTMS_VIDEO_MODE: 'individual', RTMS_BUFFER_DATA: 'true', RTMS_MEDIA_WINDOW_SEC: '45' });
  assert.deepEqual([o.config.videoMode, o.config.bufferData, o.config.windows.mediaMs], ['individual', true, 45_000]);
  assert.equal(liveMediaParams(o.config).params.video.data_opt, 4);
  assert.ok(readLiveConfig({ RTMS_MEDIA: 'audio,music' }).errors[0].includes('music'));
  assert.ok(readLiveConfig({ RTMS_VIDEO_MODE: 'all' }).errors.length);
  assert.ok(readLiveConfig({ RTMS_MEDIA_WINDOW_SEC: '-5' }).errors.length);
  const bad = liveMediaParams(readLiveConfig({ RTMS_AUDIO_CHANNELS: 'stereo' }).config);
  assert.ok(bad.problems[0].includes('Opus'));
  assert.ok(!existsSync(path.join(tmpdir(), 'definitely-not-created')));
});
