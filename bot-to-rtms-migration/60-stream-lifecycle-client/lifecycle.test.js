import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createMemoryTrace } from '../shared/trace.js';
import { createStreamClient, defaultEventSubscriptions, DEFAULT_MEDIA_PARAMS, pickMediaUrl } from './src/streamClient.js';
import { chunkId, finalArtifactId, hashMediaParams } from './src/manifest.js';
import { createGenerationIndex } from './src/generations.js';

// These tests need no RTMS server. Behavior against a live server is checked by running `npm run live` against real Zoom.

/** A local port with nothing listening on it: connections are refused immediately. */
async function closedPort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('an unreachable server: backoff attempts inside the window, then the generation ends and a new webhook is required', async () => {
  const port = await closedPort();
  const trace = createMemoryTrace();
  const client = createStreamClient({
    envelope: { product: 'meeting', tenantId: 'acme', meetingId: 'm', streamId: 's', serverUrls: `ws://127.0.0.1:${port}/signaling` },
    clientId: 'c', clientSecret: 's', trace, reconnect: { baseMs: 30, capMs: 60, maxAttempts: 50 }, windows: { signalingMs: 400, mediaMs: 400 }
  });
  const result = await client.start();
  const types = (t) => trace.events.filter((e) => e.type === t);
  assert.equal(result.stop.name, 'await_reconnection_timeout');
  assert.equal(result.manifest.degraded, true);
  assert.equal(result.manifest.requires_new_generation, true);
  assert.ok(types('reconnect_scheduled').length >= 2, 'it retried with backoff before giving up');
  assert.equal(types('reconnect_failed')[0].why, 'window_exceeded');
  assert.ok(types('reconnect_failed')[0].downMs >= 400);
  assert.ok(types('reconnect_scheduled').every((e) => e.delayMs <= e.windowRemainingMs), 'no attempt is scheduled past the window');
});

test('attempts are capped per generation even inside the window', async () => {
  const port = await closedPort();
  const trace = createMemoryTrace();
  const client = createStreamClient({
    envelope: { product: 'meeting', meetingId: 'm', streamId: 's', serverUrls: `ws://127.0.0.1:${port}/signaling` },
    clientId: 'c', clientSecret: 's', trace, reconnect: { baseMs: 10, capMs: 20, maxAttempts: 3 }, windows: { signalingMs: 60_000, mediaMs: 60_000 }
  });
  const result = await client.start();
  const failed = trace.events.filter((e) => e.type === 'reconnect_failed');
  assert.equal(failed[0].why, 'attempts_exhausted');
  assert.equal(result.stop.name, 'signal_connection_interrupted');
  assert.equal(trace.events.filter((e) => e.type === 'reconnect_scheduled').length, 3);
});

test('close() on a client that never connected finalizes instead of hanging', async () => {
  const port = await closedPort();
  const client = createStreamClient({
    envelope: { product: 'meeting', meetingId: 'm', streamId: 's', serverUrls: `ws://127.0.0.1:${port}/signaling` },
    clientId: 'c', clientSecret: 's', reconnect: { baseMs: 500, capMs: 500, maxAttempts: 5 }
  });
  client.start();
  const result = await client.close(100);
  assert.equal(result.stop.name, 'receiver_request_close');
  assert.equal(client.finalized, true);
});

test('an envelope with no signaling URL ends with an alertable stop instead of hanging', async () => {
  const trace = createMemoryTrace();
  const client = createStreamClient({ envelope: { product: 'meeting', meetingId: 'm', streamId: 's', serverUrls: { audio: 'wss://x/audio' } }, clientId: 'c', clientSecret: 's', trace });
  const result = await client.start();
  assert.equal(result.stop.alert, true);
  assert.equal(result.manifest.degraded, true);
  assert.equal(trace.events.find((e) => e.type === 'handshake_rejected').reason, 'no_signaling_url');
});

test('event subscriptions match the reference manager: speaker, join, leave, plus video and chat extras when requested', () => {
  const base = { media: ['audio', 'transcript'], mediaParams: DEFAULT_MEDIA_PARAMS };
  assert.deepEqual(defaultEventSubscriptions(base), [2, 3, 4]);
  const individual = { media: ['audio', 'video'], mediaParams: { ...DEFAULT_MEDIA_PARAMS, video: { ...DEFAULT_MEDIA_PARAMS.video, data_opt: 4 } } };
  assert.deepEqual(defaultEventSubscriptions(individual), [2, 3, 4, 5, 6, 8, 9]);
  assert.deepEqual(defaultEventSubscriptions({ media: ['audio', 'video'], mediaParams: DEFAULT_MEDIA_PARAMS }), [2, 3, 4], 'active-speaker video needs no extra events');
  assert.deepEqual(defaultEventSubscriptions({ media: ['chat'], mediaParams: DEFAULT_MEDIA_PARAMS }), [2, 3, 4, 10, 11, 12, 13, 14]);
});

test('the screen share URL is read from the key the server actually uses', () => {
  assert.equal(pickMediaUrl({ sharescreen: 'wss://a/share', audio: 'wss://a/audio' }, 'share'), 'wss://a/share');
  assert.equal(pickMediaUrl({ deskshare: 'wss://a/old' }, 'share'), 'wss://a/old');
  assert.equal(pickMediaUrl({ audio: 'wss://a/audio' }, 'transcript'), undefined);
  assert.equal(pickMediaUrl(undefined, 'audio'), undefined);
});

test('chunk ids are stable per content and unique per stream, time and bytes', () => {
  const base = { tenantId: 't', meetingId: 'm', streamId: 's', mediaType: 'audio', timestamp: 10, bytes: Buffer.from('abc') };
  assert.equal(chunkId(base), chunkId({ ...base }));
  for (const change of [{ streamId: 's2' }, { timestamp: 11 }, { bytes: Buffer.from('abd') }, { tenantId: 't2' }, { mediaType: 'video' }]) {
    assert.notEqual(chunkId(base), chunkId({ ...base, ...change }), JSON.stringify(change));
  }
  assert.equal(finalArtifactId({ tenantId: 't', meetingId: 'm', artifactType: 'summary', streamGeneration: 2 }), 't/m/summary/gen2');
  assert.equal(hashMediaParams({ b: 1, a: { d: 1, c: 2 } }), hashMediaParams({ a: { c: 2, d: 1 }, b: 1 }));
});

test('generations: the same meeting gets a numbered, linked stream per restart', () => {
  const index = createGenerationIndex();
  const key = 'acme|meeting|uuid-1';
  const g1 = index.register(key, 'stream-1');
  assert.deepEqual([g1.generation, g1.previousStreamId, g1.isNew], [1, null, true]);
  assert.equal(index.register(key, 'stream-1').isNew, false);
  const g2 = index.register(key, 'stream-2');
  assert.deepEqual([g2.generation, g2.previousStreamId], [2, 'stream-1']);
  assert.equal(index.generations(key)[0].status, 'superseded');
  index.close(key, 'stream-2');
  assert.equal(index.generations(key)[1].status, 'finalized');
  assert.deepEqual(index.generations('other'), []);
});
