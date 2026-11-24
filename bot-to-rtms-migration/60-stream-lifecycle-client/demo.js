import 'dotenv/config';
import { createMemoryTrace } from '../shared/trace.js';
import { STREAM_STATE } from '../shared/codes.js';
import { createStreamClient } from './src/streamClient.js';
import { createMockRtmsServer } from './mockRtmsServer.js';

const waitUntil = async (description, condition, timeoutMs = 1000) => {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
};

const say = (message, fields = {}) => console.log(message, Object.keys(fields).length ? JSON.stringify(fields) : '');
const everySocketReady = (client) => Object.values(client.snapshot().sockets).every((socket) => socket.state === 'ready');

async function offlineDemo() {
  const server = await createMockRtmsServer({ keepAliveMs: 10 });
  const trace = createMemoryTrace();
  const client = createStreamClient({
    envelope: { product: 'meeting', tenantId: 'offline', meetingId: 'demo-meeting', streamId: 'demo-stream', serverUrls: server.urls },
    clientId: 'offline-client',
    clientSecret: 'offline-secret',
    media: ['audio', 'transcript'],
    trace,
    reconnect: { baseMs: 1, capMs: 5, maxAttempts: 8 },
    windows: { signalingMs: 1000, mediaMs: 1000 },
    onPhase: (phase, why) => say(`phase ${phase}`, { why })
  });

  try {
    const done = client.start();
    await waitUntil('the mock sockets', () => everySocketReady(client) && client.phase === 'client_ready_sent');

    server.media('transcript', { timestamp: 1000, data: 'before the pause' });
    server.media('audio', { timestamp: 1000, data: 'AAAAAAAA' });
    server.media('audio', { timestamp: 1000, data: 'AAAAAAAA' });
    await waitUntil('the first packets', () => client.snapshot().stats.packets === 2);
    say('media received', { packets: 2, duplicates: 1 });

    server.keepAlive();
    await waitUntil('the keep-alive reply', () => client.snapshot().stats.keepAlivesAnswered >= 2);

    server.streamState(STREAM_STATE.PAUSED);
    await waitUntil('the pause', () => client.phase === 'degraded_or_paused');
    server.streamState(STREAM_STATE.RESUMED);
    await waitUntil('the resume boundary', () => trace.events.some((event) => event.type === 'stream_state' && event.state === 'RESUMED'));
    server.media('audio', { timestamp: 1100, data: 'AAAAAAAA' });
    await waitUntil('the resumed segment', () => client.snapshot().stats.packets === 3);

    server.interrupt();
    await waitUntil('the reconnect', () => trace.events.some((event) => event.type === 'socket_recovered'));
    await waitUntil('streaming again', () => client.phase === 'streaming');
    server.media('audio', { timestamp: 1200, data: 'AAAAAAAA' });
    await waitUntil('the post-recovery packet', () => client.snapshot().stats.packets === 4);

    const replacement = await server.replaceServer();
    client.refresh(replacement.serverUrls);
    await waitUntil('the replacement', () => trace.events.some((event) => event.type === 'server_urls_refreshed') && client.phase === 'streaming');
    server.media('transcript', { timestamp: 1300, data: 'after the replacement' });
    await waitUntil('replacement media', () => client.snapshot().stats.packets === 5);

    server.streamState(STREAM_STATE.TERMINATED, 6);
    const { manifest } = await done;
    say('mock stream complete', {
      stop: manifest.stop.name,
      packets: manifest.stats.packets,
      duplicates: manifest.stats.duplicatesDropped,
      keepAlives: manifest.stats.keepAlivesAnswered,
      reconnects: manifest.reconnects.length,
      segments: manifest.segments.map((segment) => `${segment.mediaType}:${segment.boundary}`)
    });
    say('offline demo complete; no credentials, files or external network used');
  } finally {
    await server.close();
  }
}

async function liveDemo(env) {
  const required = ['RTMS_SIGNALING_URL', 'ZOOM_CLIENT_ID', 'ZOOM_CLIENT_SECRET'];
  const missing = required.filter((name) => !env[name]);
  if (missing.length) {
    console.error(`Real-socket demo needs ${missing.join(', ')}. Leave them unset for the offline mock.`);
    process.exitCode = 1;
    return;
  }
  const media = String(env.RTMS_MEDIA || 'audio,transcript').split(',').map((value) => value.trim()).filter(Boolean);
  const client = createStreamClient({
    envelope: {
      product: 'meeting',
      tenantId: env.TENANT_ACCOUNT_IDS?.split(',')[0] || 'local',
      meetingId: env.RTMS_MEETING_ID || 'local-meeting',
      streamId: env.RTMS_STREAM_ID || 'local-stream',
      serverUrls: env.RTMS_SIGNALING_URL
    },
    clientId: env.ZOOM_CLIENT_ID,
    clientSecret: env.ZOOM_CLIENT_SECRET,
    media,
    onPhase: (phase, why) => say(`phase ${phase}`, { why })
  });

  process.on('SIGINT', () => client.close(1000));
  process.on('SIGTERM', () => client.close(1000));
  say(`connecting to ${env.RTMS_SIGNALING_URL}`, { media });
  const { manifest } = await client.start();
  say('real stream complete', { stop: manifest.stop.name, packets: manifest.stats.packets, degraded: manifest.degraded });
}

const offline = !process.env.RTMS_SIGNALING_URL && process.env.RTMS_DEMO_MODE !== 'real';
await (offline ? offlineDemo() : liveDemo(process.env));
