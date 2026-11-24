import test from 'node:test';
import assert from 'node:assert/strict';
import { STREAM_STATE } from '../shared/codes.js';
import { createMemoryTrace } from '../shared/trace.js';
import { createStreamClient } from './src/streamClient.js';
import { createTranscriptStore } from './src/transcriptStore.js';
import { createMockRtmsServer } from './mockRtmsServer.js';

async function until(description, condition, timeoutMs = 1000) {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

const audio = (timestamp, data = 'AAAAAAAA') => ({ timestamp, data });
const transcript = (timestamp, text) => ({ timestamp, data: text });
const everySocketReady = (client) => Object.values(client.snapshot().sockets).every((socket) => socket.state === 'ready');

test('mock server exercises the established connection: keep-alive, media, pause, resume and reconnect', async () => {
  const server = await createMockRtmsServer({ keepAliveMs: 5 });
  const trace = createMemoryTrace();
  const client = createStreamClient({
    envelope: { product: 'meeting', tenantId: 'acme', meetingId: 'mock-meeting', streamId: 'mock-stream', serverUrls: server.urls },
    clientId: 'mock-client',
    clientSecret: 'mock-secret',
    media: ['audio', 'transcript'],
    trace,
    reconnect: { baseMs: 1, capMs: 5, maxAttempts: 8 },
    windows: { signalingMs: 1000, mediaMs: 1000 }
  });
  const done = client.start();

  try {
    await until('every requested socket', () => everySocketReady(client) && client.phase === 'client_ready_sent');
    assert.equal(server.media('audio', audio(1000)), 1);
    assert.equal(server.media('audio', audio(1000)), 1, 'the exact replay is a duplicate');
    assert.equal(server.media('transcript', transcript(1000, 'Hello')), 1);
    await until('both media types to arrive', () => client.snapshot().stats.packets === 2);

    server.streamState(STREAM_STATE.PAUSED);
    await until('the pause', () => trace.events.some((event) => event.type === 'stream_state' && event.state === 'PAUSED'));
    server.streamState(STREAM_STATE.RESUMED);
    await until('the resume', () => trace.events.some((event) => event.type === 'stream_state' && event.state === 'RESUMED'));
    assert.equal(server.media('audio', audio(1100)), 1);
    await until('the post-resume packet', () => client.snapshot().stats.packets === 3);

    server.interrupt();
    await until('the socket recovery', () => trace.events.some((event) => event.type === 'socket_recovered'));
    await until('streaming after reconnect', () => client.phase === 'streaming');
    assert.equal(server.media('audio', audio(1200)), 1);
    await until('the post-reconnect packet', () => client.snapshot().stats.packets === 4);

    server.streamState(STREAM_STATE.TERMINATED, 6);
    const result = await done;
    const types = (type) => trace.events.filter((event) => event.type === type);

    assert.equal(result.stop.name, 'meeting_ended');
    assert.equal(result.manifest.stats.packets, 4);
    assert.equal(result.manifest.stats.duplicatesDropped, 1);
    assert.ok(result.manifest.stats.keepAlivesAnswered >= 1);
    assert.ok(result.manifest.reconnects.length >= 1);
    assert.equal(result.manifest.segments.filter((segment) => segment.mediaType === 'audio').length, 2);
    assert.equal(result.manifest.segments.find((segment) => segment.mediaType === 'audio')?.boundary, 'start');
    assert.equal(result.manifest.segments.filter((segment) => segment.mediaType === 'audio' && segment.boundary === 'resume').length, 1);
    assert.ok(types('socket_recovered').length >= 1);
    assert.ok(types('stream_state').some((event) => event.state === 'PAUSED'));

    const sent = server.messages().map((entry) => entry.msg);
    const handshakes = sent.filter((msg) => msg.msg_type === 1 || msg.msg_type === 3);
    assert.ok(handshakes.length >= 3, 'signaling plus one handshake per media type');
    assert.ok(handshakes.every((msg) => msg.protocol_version === 2), 'both handshakes use RTMS protocol V2');
    assert.ok(handshakes.every((msg) => !('payload_encryption' in msg)), 'V2 negotiates encryption only in signaling');
    assert.ok(handshakes.every((msg) => msg.msg_type !== 3 || msg.media_type !== 32), 'one concrete media type per connection');
    const subscription = sent.find((msg) => msg.msg_type === 5);
    assert.deepEqual(subscription?.events, [1000, 1001, 1002].map((event_code) => ({ event_code, subscribe: true })));
    assert.equal(result.manifest.rtms_protocol_version, 2);
  } finally {
    await server.close();
  }
});

test('mock server exercises silence detection without hard-coded sleeps in the client path', async () => {
  const server = await createMockRtmsServer();
  const trace = createMemoryTrace();
  const client = createStreamClient({
    envelope: { product: 'meeting', meetingId: 'silent-meeting', streamId: 'silent-stream', serverUrls: server.urls },
    clientId: 'mock-client',
    clientSecret: 'mock-secret',
    media: ['audio'],
    trace,
    reconnect: { baseMs: 1, capMs: 2, maxAttempts: 3 },
    keepAliveSilenceLimitMs: 20,
    keepAliveCheckMs: 2
  });
  const done = client.start();
  try {
    await until('the connection', () => client.phase === 'client_ready_sent');
    server.media('audio', audio(1));
    await until('the first packet', () => client.phase === 'streaming');

    await until('keep-alive silence', () => trace.events.some((event) => event.type === 'keepalive_silence'));
    await until('the silent socket recovers', () => trace.events.some((event) => event.type === 'socket_recovered'));
    client.close(50);
    const result = await done;

    assert.equal(result.stop.name, 'receiver_request_close');
    assert.equal(client.finalized, true);
  } finally {
    await server.close();
  }
});

test('mock server replacement drives client.refresh to a new real socket pair', async () => {
  const server = await createMockRtmsServer();
  const trace = createMemoryTrace();
  const firstUrls = server.urls;
  const client = createStreamClient({
    envelope: { product: 'meeting', meetingId: 'refresh-meeting', streamId: 'refresh-stream', serverUrls: firstUrls },
    clientId: 'mock-client',
    clientSecret: 'mock-secret',
    media: ['audio'],
    trace,
    reconnect: { baseMs: 1, capMs: 2, maxAttempts: 3 }
  });
  const done = client.start();
  try {
    await until('the first connection', () => client.phase === 'client_ready_sent');

    const replacement = await server.replaceServer();
    assert.notEqual(replacement.serverUrls.signaling, firstUrls.signaling);
    assert.equal(client.refresh(replacement.serverUrls).applied, true);
    await until('the refresh event', () => trace.events.some((event) => event.type === 'server_urls_refreshed'));
    await until('streaming from the replacement', () => client.phase === 'streaming');
    assert.equal(server.media('audio', audio(2)), 1);
    await until('media from the replacement', () => client.snapshot().stats.packets === 1);

    client.close(50);
    const result = await done;
    assert.equal(result.stop.name, 'receiver_request_close');
    assert.notEqual(result.manifest.stream_id, undefined);
  } finally {
    await server.close();
  }
});

test('transcript revisions with sibling sentence_id and attribute replace the sentence in place', async () => {
  const server = await createMockRtmsServer();
  const store = createTranscriptStore();
  const client = createStreamClient({
    envelope: { product: 'meeting', tenantId: 'acme', meetingId: 'tx-meeting', streamId: 'tx-stream', serverUrls: server.urls },
    clientId: 'mock-client',
    clientSecret: 'mock-secret',
    media: ['transcript'],
    onPacket: (packet) => { if (packet.mediaType === 'transcript') store.add(packet); }
  });
  const done = client.start();
  try {
    await until('transcript socket ready', () => everySocketReady(client) && client.phase === 'client_ready_sent');
    server.media('transcript', { timestamp: 1000, user_id: 1, user_name: 'Ana', sentence_id: 42, attribute: 1, data: 'Hello ward' });
    server.media('transcript', { timestamp: 1200, user_id: 1, user_name: 'Ana', sentence_id: 42, attribute: 2, data: 'Hello world' });
    server.media('transcript', { timestamp: 1300, user_id: 2, user_name: 'Ben', sentence_id: 99, attribute: 2, data: 'Missed initial packet' });
    await until('three transcript packets processed', () => client.snapshot().stats.packets === 3);

    assert.equal(store.lines().length, 2);
    assert.equal(store.lines()[0].text, 'Hello world');
    assert.equal(store.lines()[0].sentenceId, 42);
    assert.equal(store.lines()[1].text, 'Missed initial packet');

    client.close(50);
    await done;
  } finally {
    await server.close();
  }
});
