import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createClaimRegistry } from '../shared/claims.js';
import { createMemoryTrace } from '../shared/trace.js';
import { createTenantGate } from '../shared/tenantGate.js';
import { classifyRestOutcome, EVENT_TYPE, MSG, REST_OUTCOMES, STREAM_STATE } from '../shared/codes.js';
import { signWebhook } from '../shared/webhookSignature.js';
import { entityKeyForProduct, normalizeStartedPayload } from '../shared/rtmsPayload.js';
import { createLiveBridge } from '../50-start-and-approval/src/liveBridge.js';
import { createRetryingRestClient } from '../50-start-and-approval/src/retryingRestClient.js';
import { createStartService } from '../50-start-and-approval/src/service.js';
import { readLiveConfig } from '../60-stream-lifecycle-client/src/liveSession.js';
import { createTranscriptStore } from '../60-stream-lifecycle-client/src/transcriptStore.js';
import { createStreamClient, DEFAULT_MEDIA_PARAMS } from '../60-stream-lifecycle-client/src/streamClient.js';
import { createMockRtmsServer } from '../60-stream-lifecycle-client/mockRtmsServer.js';
import { buildReport } from '../70-reporting-dashboard/src/report.js';
import { createArtifactReconciler } from '../70-reporting-dashboard/src/artifactLifecycle.js';

const everySocketReady = (client) => Object.values(client.snapshot().sockets).every((socket) => socket.state === 'ready');

async function until(description, condition, timeoutMs = 2000) {
  const end = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < end) {
    try {
      if (condition()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw lastError || new Error(`timed out waiting for ${description}`);
}

function rig({ env = {}, onStreamStopped = () => {} } = {}) {
  const outputDir = mkdtempSync(path.join(tmpdir(), 'f3-coverage-'));
  const { config, errors } = readLiveConfig({
    RTMS_MEDIA: 'audio,video,share,transcript,chat',
    RTMS_VIDEO_MODE: 'individual',
    RTMS_OUTPUT_DIR: outputDir,
    RTMS_STATS_EVERY_SEC: '0',
    RTMS_SAVE_TRANSCRIPT: 'true',
    RTMS_RECONNECT_BASE_MS: '1',
    RTMS_RECONNECT_CAP_MS: '2',
    ...env
  });
  assert.deepEqual(errors, []);
  const trace = createMemoryTrace();
  const claims = createClaimRegistry({ leaseMs: 60_000 });
  const gate = createTenantGate([{
    tenantId: 'acme',
    accountIds: ['A1'],
    products: ['meeting', 'webinar', 'videoSdk', 'contactCenter'],
    media: ['audio', 'video', 'share', 'transcript', 'chat'],
    consentRef: 'consent-1',
    policyVersion: 'p1'
  }]);
  let service;
  const bridge = createLiveBridge({
    credentials: { clientId: 'client', clientSecret: 'secret' },
    config, trace, getService: () => service
  });
  service = createStartService({
    secret: 'wh-secret',
    clientId: 'client',
    trace,
    claims,
    gate,
    rest: { start: async () => ({ outcome: { ...classifyRestOutcome(204), dryRun: false } }) },
    media: config.media,
    onStreamReady: bridge.onStreamReady,
    onStreamRefresh: bridge.onStreamRefresh,
    onStreamStopped,
    onAlert: () => {}
  });
  const send = async (event, payload) => {
    const rawBody = Buffer.from(JSON.stringify({ event, event_ts: 1, payload }));
    const response = service.handleWebhook({ headers: signWebhook(rawBody, 'wh-secret'), rawBody });
    await response.done;
    return response;
  };
  const started = (extra = {}) => ({
    account_id: 'A1', meeting_uuid: 'meeting-1', meeting_id: '123',
    rtms_stream_id: 'stream-1', server_urls: null, ...extra
  });
  return { outputDir, config, trace, claims, service, bridge, send, started };
}

async function startedRig() {
  const server = await createMockRtmsServer();
 const state = rig({});
  const payload = state.started({ server_urls: server.urls });
  await state.send('meeting.rtms_started', payload);
  await until('the claimed session to connect', () => {
    const session = state.bridge.sessions.get('stream-1');
    return Boolean(session && everySocketReady(session.client));
  });
  return { server, ...state };
}

test('the F3 demo path claims a webhook, hands it through the live bridge and consumes the local mock', async () => {
const state = await startedRig();
  const { server, bridge, claims, trace } = state;
  try {
    const session = bridge.sessions.get('stream-1');
    assert.equal(session.client.phase, 'client_ready_sent');
    assert.equal(claims.get('acme|meeting|meeting-1|stream-1').state, 'held');

    const changes = [];
    session.registry.subscribe((change) => changes.push(change.type));
    server.event({ event_type: EVENT_TYPE.PARTICIPANT_JOIN, timestamp: 1, participants: [{ user_id: 1, user_name: 'Ana' }, { user_id: 2, user_name: 'Ben' }] });
    server.event({ event_type: EVENT_TYPE.PARTICIPANT_VIDEO_ON, timestamp: 2, participants: [{ user_id: 1 }] });
    server.event({ event_type: EVENT_TYPE.PARTICIPANT_JOIN, timestamp: 3, participants: [{ user_id: 1, user_name: 'Ana Lee' }] });
    server.event({ event_type: EVENT_TYPE.PARTICIPANT_LEAVE, timestamp: 4, user_id: 2 });
    await until('join, video, rename and leave registry events', () => ['join', 'video_on', 'rename', 'leave'].every((type) => changes.includes(type)));
    assert.equal(session.registry.get(1).names.at(-1).name, 'Ana Lee');
    assert.equal(session.registry.get(2).presence[0].to, 4);

    server.media('share', { timestamp: 10, data: 'UklERg==' });
    server.media('chat', { timestamp: 11, data: 'hello from chat' });
    server.media('transcript', { timestamp: 12, data: JSON.stringify({ sentence_id: 's1', attribute: 1, text: 'Hello' }) });
    await until('share, chat and transcript packets', () => {
      const counts = session.counts;
      return counts.share === 1 && counts.chat === 1 && counts.transcript === 1;
    });

    await bridge.shutdown(100);
    const result = await session.done;
    await until('the service claim to be released', () => state.service.snapshot().active.length === 0);
    assert.equal(claims.get('acme|meeting|meeting-1|stream-1').state, 'released');
    assert.equal(result.manifest.stats.packets, 3);
    const transcript = JSON.parse(readFileSync(path.join(result.dir, 'transcript.jsonl'), 'utf8'));
    assert.equal(transcript.text, 'Hello');
    assert.ok(trace.events.some((event) => event.type === 'stream_claimed'));
  } finally {
    await server.close();
  }
});

test('the mock completes the video-subscription request/response loop through a connected client', async () => {
  const state = await startedRig();
  const { server, bridge, trace } = state;
  try {
    const session = bridge.sessions.get('stream-1');
    server.event({ event_type: EVENT_TYPE.PARTICIPANT_VIDEO_ON, timestamp: 20, participants: [{ user_id: 7, user_name: 'Zed' }] });
    await until('the subscription response', () => session.manager.state().current === 7);
    assert.equal(session.manager.state().inflight, null);
    assert.ok(trace.events.some((event) => event.type === 'video_subscription_changed' && event.userId === 7));
    const request = server.messages().at(-1).msg;
    assert.equal(request.msg_type, MSG.VIDEO_SUBSCRIPTION_REQ);
  } finally {
    await server.close();
  }
});

test('meeting, webinar, Video SDK and Contact Center payloads reach product-correct sockets', async () => {
  const cases = [
    ['meeting.rtms_started', { meeting_uuid: 'meeting-uuid' }, 'meeting-uuid'],
    ['webinar.rtms_started', { webinar_uuid: 'webinar-uuid' }, 'webinar-uuid'],
    ['session.rtms_started', { session_id: 'session-id' }, 'session-id'],
    ['contact_center.voice_rtms_started', { engagement_id: 'engagement-id' }, 'engagement-id']
  ];
  const server = await createMockRtmsServer();
  try {
    for (const [event, object, expectedId] of cases) {
      const normalized = normalizeStartedPayload(event, { object });
      const client = createStreamClient({
        envelope: {
          product: normalized.product, meetingId: normalized.meetingId, streamId: 'product-stream',
          serverUrls: server.urls
        },
        clientId: 'client', clientSecret: 'secret', media: ['audio']
      });
      const done = client.start();
      await until(`${normalized.product} sockets`, () => everySocketReady(client));
      const handshake = server.messages().filter((entry) => entry.msg.msg_type === MSG.SIGNALING_HAND_SHAKE_REQ).at(-1).msg;
      assert.equal(handshake[entityKeyForProduct(normalized.product)], expectedId);
      client.close(10);
      await done;
    }
  } finally {
    await server.close();
  }
});

test('a long outage is reconciled as a gap and TERMINATING has a bounded graceful stop', async () => {
  const server = await createMockRtmsServer();
  try {
    const trace = createMemoryTrace();
    let client = createStreamClient({
      envelope: { product: 'meeting', meetingId: 'gap-meeting', streamId: 'gap-stream', serverUrls: server.urls },
      clientId: 'client', clientSecret: 'secret', media: ['audio'], trace,
      reconnect: { baseMs: 1, capMs: 2, maxAttempts: 8 }, gapThresholdMs: 100
    });
    let done = client.start();
    await until('the gap client', () => everySocketReady(client));
    server.media('audio', { timestamp: 1000, data: 'AAAA' });
    await until('pre-outage media', () => client.snapshot().stats.packets === 1);
    server.interrupt();
    await until('the outage to recover', () => trace.events.some((event) => event.type === 'socket_recovered') && client.phase === 'streaming' && everySocketReady(client));
    server.media('audio', { timestamp: 5000, data: 'BBBB' });
    await until('post-outage media', () => client.snapshot().stats.packets === 2);
    client.close(10);
    let result = await done;
    assert.deepEqual(result.manifest.gaps, [{ mediaType: 'audio', fromTs: 1000, toTs: 5000, ms: 4000, cause: 'reconnect' }]);
    assert.equal(result.manifest.degraded, true);

    trace.events.length = 0;
    client = createStreamClient({
      envelope: { product: 'meeting', meetingId: 'terminating-meeting', streamId: 'terminating-stream', serverUrls: server.urls },
      clientId: 'client', clientSecret: 'secret', media: ['audio'], trace, terminatingGraceMs: 1
    });
    done = client.start();
    await until('the terminating client', () => everySocketReady(client));
    server.streamState(STREAM_STATE.TERMINATING, 10);
    result = await done;
    assert.equal(result.stop.code, 10);
    assert.equal(result.stop.name, 'internal_exception');
    assert.ok(trace.events.some((event) => event.type === 'stream_state' && event.state === 'TERMINATING'));

    assert.equal(classifyRestOutcome(204).waitForWebhook, true);
    assert.equal(classifyRestOutcome(400, { code: 3000 }).retry, 'later');
    assert.equal(classifyRestOutcome(400, { code: 13267 }).name, 'rtms_app_disabled');
    assert.equal(classifyRestOutcome(404).name, 'not_found');
    assert.equal(classifyRestOutcome(429).retry, 'backoff');
  } finally {
    await server.close();
  }
});

test('stop reason 8 drives purge, deletion confirmations and the dashboard alert', async () => {
  const deleted = [];
  let reconciler;
  const state = rig({
    onStreamStopped: async (stream, decision) => {
      const result = await reconciler.reconcileStop({ stream, decision });
      if (decision.code === 6) assert.deepEqual(result, { purged: false, reason: 'purge_not_required', deleted: [] });
      return result;
    }
  });
  const artifacts = [{ id: 'manifest' }, { id: 'audio' }];
  reconciler = createArtifactReconciler({
    listArtifacts: () => artifacts,
    deleteArtifact: async (artifact) => deleted.push(artifact.id),
    trace: state.trace
  });
  await state.send('meeting.rtms_started', state.started({ server_urls: 'ws://127.0.0.1:1/signaling' }));
  await state.send('meeting.rtms_stopped', { rtms_stream_id: 'stream-1', stop_reason: 8 });
  assert.deepEqual(deleted, ['manifest', 'audio']);
  const stop = state.trace.events.find((event) => event.type === 'stream_stopped');
  assert.equal(stop.purge, true);
  const report = buildReport(state.trace.events);
  assert.ok(report.alerts.some((alert) => alert.level === 'critical' && alert.text.includes('stream-1')));
  assert.ok(state.trace.events.some((event) => event.type === 'artifact_deleted'));
});

test('REST 429 is retried automatically with Retry-After, then documented backoff', async () => {
  const delays = [];
  let call = 0;
  const responses = [
    { outcome: { name: 'rate_limited', retry: 'backoff', retryAfterSeconds: 7 } },
    { outcome: { name: 'rate_limited', retry: 'backoff', retryAfterSeconds: null } },
    { outcome: { name: 'accepted', retry: 'never', waitForWebhook: true } }
  ];
  const rest = { start: async () => responses[call++] };
  const retried = createRetryingRestClient(rest, {
    random: () => 0.5,
    sleepImpl: async (ms) => delays.push(ms)
  });
  const response = await retried.start('123', { participantUserId: 'u1' });
  assert.equal(response.outcome.name, 'accepted');
  assert.equal(call, 3);
  assert.equal(rest.start.length, 0);
  assert.equal(delays.length, 2);
  assert.equal(delays[0], 7000);
  assert.equal(delays[1], 500);
  assert.equal(REST_OUTCOMES[429].action.includes('Back off'), true);
});

test('transcript UPDATE replaces the sentence instead of appending a second line', () => {
  const packet = (event) => ({ timestamp: 1, userId: 9, userName: 'Ana', bytes: Buffer.from(JSON.stringify(event)) });
  const store = createTranscriptStore();
  const first = store.add(packet({ sentence_id: 'abc', attribute: 1, text: 'Helo' }));
  const revised = store.add(packet({ sentence_id: 'abc', attribute: 2, text: 'Hello' }));
  const unrelated = store.add(packet({ sentence_id: 'def', attribute: 1, text: 'World' }));
  assert.deepEqual([first.changed, first.revised, revised.changed, revised.revised, unrelated.index], [true, false, true, true, 1]);
  assert.deepEqual(store.lines().map((line) => line.text), ['Hello', 'World']);
  assert.equal(store.text(), 'Hello World');
});
