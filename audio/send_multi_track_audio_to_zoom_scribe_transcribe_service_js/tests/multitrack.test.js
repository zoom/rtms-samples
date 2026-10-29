import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.ZOOM_API_KEY ||= 'test-api-key';
process.env.ZOOM_API_SECRET ||= 'test-api-secret';
process.env.SCRIBE_LANGUAGE = 'en-US';
process.env.SCRIBE_INPUT_MODE = 'multitrack';
process.env.SCRIBE_DIARIZATION = 'false';
process.env.SCRIBE_INTERIM_RESULTS = 'false';
process.env.SCRIBE_LOG_RAW_EVENTS = 'false';
process.env.SCRIBE_SAVE_DIARIZED_TRANSCRIPT = 'false';
process.env.SCRIBE_PING_INTERVAL_MS = '20';
process.env.SCRIBE_HEARTBEAT_IDLE_MS = '25';
process.env.SCRIBE_RECONNECT_DELAY_MS = '10';
// 300 ms per participant = 9600 bytes = three 100 ms RTMS frames.
process.env.SCRIBE_PENDING_AUDIO_MS = '300';
process.env.SCRIBE_VOCABULARY_JSON = JSON.stringify({ phrases: ['AIAGW'] });

const {
  buildAppendMessage,
  buildDiarizedTranscript,
  buildSessionUpdatePayload,
  cleanupMeeting,
  formatUtterance,
  getSessionSnapshot,
  initializeLiveScribeSession,
  laneOf,
  needsSilenceHeartbeat,
  sendAudioChunk,
  setWebSocketFactoryForTesting,
  writeDiarizedTranscript,
} = await import('../scribeClient.js');

const FRAME_BYTES = 3200; // 100 ms of 16 kHz mono PCM16
const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class FakeWebSocket extends EventEmitter {
  constructor({ autoAck = true } = {}) {
    super();
    this.readyState = 0;
    this.sent = [];
    this.pings = 0;
    this.autoAck = autoAck;
    queueMicrotask(() => {
      this.readyState = 1;
      this.emit('open');
    });
  }

  send(data) {
    this.sent.push(data);
    if (Buffer.isBuffer(data)) return;
    const message = JSON.parse(String(data));
    if (message.type === 'session.update' && this.autoAck) this.ack(message);
    if (message.type === 'session.close') {
      queueMicrotask(() => this.serverSend({ type: 'session.closed', reason: 'client_requested' }));
    }
  }

  ack(message = {}) {
    queueMicrotask(() => this.serverSend({
      type: 'session.updated',
      input_mode: message.audio?.input_mode ?? 'multitrack',
      diarization_enabled: false,
    }));
  }

  serverSend(event) {
    this.emit('message', Buffer.from(JSON.stringify(event)), false);
  }

  ping() {
    this.pings += 1;
  }

  close(code = 1000, reason = '') {
    if (this.readyState === 3) return;
    this.readyState = 3;
    queueMicrotask(() => this.emit('close', code, Buffer.from(reason)));
  }

  terminate() {
    this.close(1006, 'terminated');
  }

  // Everything sent after session.update: appends decoded, audio as its size.
  wire() {
    return this.sent
      .map((data) => (Buffer.isBuffer(data) ? { binary: data.length } : JSON.parse(String(data))))
      .filter((message) => message.type !== 'session.update');
  }
}

function useFakeSockets(options) {
  const sockets = [];
  setWebSocketFactoryForTesting(() => {
    const socket = new FakeWebSocket(options);
    sockets.push(socket);
    return socket;
  });
  return sockets;
}

function captureConsole(method) {
  const original = console[method];
  const lines = [];
  console[method] = (...args) => lines.push(args.join(' '));
  return { lines, restore: () => { console[method] = original; } };
}

const pcm = () => Buffer.alloc(FRAME_BYTES);

test('session.update requests multitrack lanes with only supported config fields', () => {
  const payload = buildSessionUpdatePayload();
  assert.equal(payload.type, 'session.update');
  assert.deepEqual(payload.audio, { format: 'pcm16', input_mode: 'multitrack' });
  assert.equal(payload.config.language, 'en-US');
  assert.equal(payload.config.diarization, false);
  assert.equal(payload.config.interim_results, false);
  assert.deepEqual(payload.config.vocabulary, { phrases: ['AIAGW'] });
  assert.equal('channel_separation' in payload.config, false);
  assert.equal('output_format' in payload.config, false);
});

test('append carries the RTMS identity and an integer epoch-ms timestamp', () => {
  assert.deepEqual(
    buildAppendMessage({ userId: 16778240, userName: 'Chun Siong Tan', timestamp: 1788334063359 }),
    {
      type: 'input_audio_buffer.append',
      metadata: { timestamp: 1788334063359, user_id: 16778240, user_name: 'Chun Siong Tan' },
    }
  );
  // Micro- and nanosecond clocks are normalized and rounded: the gateway rejects fractions.
  assert.equal(buildAppendMessage({ userId: 1, timestamp: 1788334063359123 }).metadata.timestamp, 1788334063359);
  assert.equal(buildAppendMessage({ userId: 1, timestamp: 1788334063359123456 }).metadata.timestamp, 1788334063359);
  // A clock that is not epoch milliseconds is left out rather than guessed.
  assert.equal('timestamp' in buildAppendMessage({ userId: 1, timestamp: 1788334063 }).metadata, false);
  assert.equal('timestamp' in buildAppendMessage({ userId: 1 }).metadata, false);
  // user_id 0 is a real identity; a missing one cannot be demultiplexed.
  assert.equal(buildAppendMessage({ userId: 0 }).metadata.user_id, 0);
  assert.equal(buildAppendMessage({ userName: 'Nobody' }), null);
});

test('each audio frame is an append immediately followed by its binary PCM', async () => {
  const sockets = useFakeSockets();
  const meetingUuid = 'paired-append-test';
  initializeLiveScribeSession(meetingUuid);
  await tick(10);

  sendAudioChunk(pcm(), meetingUuid, { userId: 101, userName: 'Alpha', timestamp: 1788334063000 });
  sendAudioChunk(pcm(), meetingUuid, { userId: 202, userName: 'Bravo', timestamp: 1788334063020 });

  assert.deepEqual(sockets[0].wire(), [
    { type: 'input_audio_buffer.append', metadata: { timestamp: 1788334063000, user_id: 101, user_name: 'Alpha' } },
    { binary: FRAME_BYTES },
    { type: 'input_audio_buffer.append', metadata: { timestamp: 1788334063020, user_id: 202, user_name: 'Bravo' } },
    { binary: FRAME_BYTES },
  ]);

  await cleanupMeeting(meetingUuid);
  setWebSocketFactoryForTesting();
});

test('audio before session.updated is flushed in pairs, bounded per participant', async () => {
  const sockets = useFakeSockets({ autoAck: false });
  const meetingUuid = 'pending-backlog-test';
  initializeLiveScribeSession(meetingUuid);
  await tick(10);

  const arrivals = [
    [101, 0], [202, 0], [101, 100], [101, 200], [202, 100], [101, 300], [101, 400],
  ];
  for (const [userId, offset] of arrivals) {
    sendAudioChunk(pcm(), meetingUuid, { userId, timestamp: 1788334063000 + offset });
  }
  assert.equal(sockets[0].wire().length, 0, 'nothing is sent before session.updated');
  assert.equal(getSessionSnapshot(meetingUuid).droppedFrames, 2, "101's two oldest frames exceed its 300 ms cap");

  sockets[0].ack({ audio: { input_mode: 'multitrack' } });
  await tick(5);

  const wire = sockets[0].wire();
  const sentOrder = [];
  for (let index = 0; index < wire.length; index += 2) {
    assert.equal(wire[index].type, 'input_audio_buffer.append');
    assert.deepEqual(wire[index + 1], { binary: FRAME_BYTES }, 'every append is followed by its audio');
    sentOrder.push([wire[index].metadata.user_id, wire[index].metadata.timestamp - 1788334063000]);
  }
  // Arrival order is preserved; only 101's oldest audio was dropped.
  assert.deepEqual(sentOrder, [[202, 0], [101, 200], [202, 100], [101, 300], [101, 400]]);
  assert.equal(getSessionSnapshot(meetingUuid).queuedBytes, 0);

  await cleanupMeeting(meetingUuid);
  setWebSocketFactoryForTesting();
});

test('audio without a participant identity is dropped, not sent unattributed', async () => {
  const sockets = useFakeSockets();
  const meetingUuid = 'missing-identity-test';
  initializeLiveScribeSession(meetingUuid);
  await tick(10);
  const warnings = captureConsole('warn');

  sendAudioChunk(pcm(), meetingUuid, { userName: 'Nobody', timestamp: 1788334063000 });
  warnings.restore();

  assert.equal(sockets[0].wire().length, 0);
  assert.equal(getSessionSnapshot(meetingUuid).droppedFrames, 1);
  assert.ok(warnings.lines.some((line) => line.includes('without a user_id')));

  await cleanupMeeting(meetingUuid);
  setWebSocketFactoryForTesting();
});

test('utterance reports the gateway-attributed participant and absolute times', () => {
  const utterance = formatUtterance('meeting-uuid', {
    type: 'transcription.completed',
    item_id: 'l1:seg_3',
    transcript: 'so I think we should ship it',
    audio_start_ms: 1200,
    audio_end_ms: 3400,
    start_timestamp: 1788334064899,
    end_timestamp: 1788334067099,
    metadata: { timestamp: 1788334063359, user_id: 16778240, user_name: 'Chun Siong Tan' },
  }, 1788334067500);

  assert.deepEqual(utterance, {
    event: 'transcript.utterance',
    source_event: 'transcription.completed',
    meeting_uuid: 'meeting-uuid',
    item_id: 'l1:seg_3',
    participant: { user_id: 16778240, user_name: 'Chun Siong Tan' },
    start_time: 1788334064899,
    end_time: 1788334067099,
    received_time: 1788334067500,
    text: 'so I think we should ship it',
  });
  assert.equal('speaker' in utterance, false, 'no diarization label without diarization');
});

test('a spliced utterance keeps per-participant segments on the epoch timescale', () => {
  const utterance = formatUtterance('meeting-uuid', {
    type: 'transcription.completed',
    item_id: 'seg_9',
    transcript: 'are we done yes we are',
    audio_start_ms: 1000,
    audio_end_ms: 4000,
    start_timestamp: 1788334070000,
    end_timestamp: 1788334073000,
    metadata_segments: [
      { metadata: { user_id: 101, user_name: 'Alpha' }, audio_start_ms: 1000, audio_end_ms: 1800 },
      { metadata: {}, audio_start_ms: 1800, audio_end_ms: 2000 },
      { metadata: { user_id: 202, user_name: 'Bravo' }, audio_start_ms: 2000, audio_end_ms: 4000 },
    ],
  });

  assert.deepEqual(utterance.participant, { user_id: 202, user_name: 'Bravo' }, 'longest source wins');
  assert.deepEqual(utterance.participant_segments, [
    { participant: { user_id: 101, user_name: 'Alpha' }, start_time: 1788334070000, end_time: 1788334070800 },
    { participant: null, start_time: 1788334070800, end_time: 1788334071000 },
    { participant: { user_id: 202, user_name: 'Bravo' }, start_time: 1788334071000, end_time: 1788334073000 },
  ]);
});

test('diarization labels are reported beside the RTMS participant, never merged into it', () => {
  const utterance = formatUtterance('meeting-uuid', {
    type: 'transcription.completed',
    item_id: 'l0:seg_2',
    transcript: 'I agree ship it',
    audio_start_ms: 1200,
    audio_end_ms: 3400,
    start_timestamp: 1788334064899,
    end_timestamp: 1788334067099,
    speaker: 'Speaker 2',
    speaker_segments: [
      { speaker: 'Speaker 1', transcript: 'I agree', audio_start_ms: 1200, audio_end_ms: 2000 },
      { speaker: 'Speaker 2', transcript: 'ship it', audio_start_ms: 2000, audio_end_ms: 3400 },
    ],
    metadata: { user_id: 200, user_name: 'Conference Room' },
    source_speaker_count: 3,
  });

  assert.deepEqual(utterance.participant, { user_id: 200, user_name: 'Conference Room' });
  assert.equal(utterance.speaker, 'Speaker 2');
  assert.equal(utterance.source_speaker_count, 3);
  assert.deepEqual(utterance.speaker_segments, [
    { speaker: 'Speaker 1', text: 'I agree', start_time: 1788334064899, end_time: 1788334065699 },
    { speaker: 'Speaker 2', text: 'ship it', start_time: 1788334065699, end_time: 1788334067099 },
  ]);
});

test('laneOf reads the gateway lane prefix', () => {
  assert.equal(laneOf('l0:seg_4'), 0);
  assert.equal(laneOf('l2:seg_1'), 2);
  assert.equal(laneOf('seg_7'), null, 'auto keeps lane 0 unprefixed');
  assert.equal(laneOf(undefined), null);
});

test('final transcript is sorted by absolute start time, not arrival order', () => {
  const document = buildDiarizedTranscript('meeting-uuid', [
    { event: 'transcript.utterance', item_id: 'l1:seg_1', start_time: 3000, received_time: 9000, text: 'third' },
    { event: 'transcript.utterance', item_id: 'l0:seg_1', start_time: 1000, received_time: 9500, text: 'first' },
    { event: 'transcript.utterance', item_id: 'l0:seg_2', start_time: null, received_time: 2000, text: 'second' },
  ], 9999);

  assert.equal(document.event, 'transcript.final');
  assert.equal(document.generated_time, 9999);
  assert.deepEqual(document.utterances.map((item) => item.text), ['first', 'second', 'third']);
  assert.equal('event' in document.utterances[0], false);
});

test('final transcript is saved as private JSON with a sanitized file name', async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'scribe-multitrack-'));
  const document = buildDiarizedTranscript('meeting/uuid+', [
    { participant: { user_id: 101, user_name: 'Alpha' }, start_time: 1000, received_time: 1500, text: 'Saved.' },
  ], 1785905381000);

  try {
    const filePath = await writeDiarizedTranscript(outputDir, document);
    const fileStats = await stat(filePath);
    assert.equal(path.dirname(filePath), outputDir);
    assert.match(path.basename(filePath), /^meeting_uuid_-.*\.json$/);
    assert.equal(fileStats.mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(filePath, 'utf8')), document);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test('multitrack sessions stay alive with WebSocket pings, not synthetic audio', async () => {
  const sockets = useFakeSockets();
  const meetingUuid = 'ping-liveness-test';
  initializeLiveScribeSession(meetingUuid);
  await tick(90);

  assert.ok(sockets[0].pings >= 2, `expected repeated pings, got ${sockets[0].pings}`);
  assert.equal(sockets[0].sent.filter((data) => Buffer.isBuffer(data)).length, 0);

  await cleanupMeeting(meetingUuid);
  setWebSocketFactoryForTesting();
});

test('silence heartbeats are only for auto sessions that have not switched to lanes', () => {
  const base = { idleMs: 30, heartbeatIdleMs: 25 };
  assert.equal(needsSilenceHeartbeat({ ...base, inputMode: 'multitrack', lanesObserved: false }), false);
  assert.equal(needsSilenceHeartbeat({ ...base, inputMode: 'auto', lanesObserved: false }), true);
  assert.equal(needsSilenceHeartbeat({ ...base, inputMode: 'auto', lanesObserved: true }), false);
  assert.equal(needsSilenceHeartbeat({ ...base, idleMs: 10, inputMode: 'auto', lanesObserved: false }), false);
});

test('multitrack_capacity warnings are counted and do not end the session', async () => {
  const sockets = useFakeSockets();
  const meetingUuid = 'multitrack-capacity-test';
  initializeLiveScribeSession(meetingUuid);
  await tick(10);
  const warnings = captureConsole('warn');

  for (let index = 0; index < 2; index += 1) {
    sockets[0].serverSend({
      type: 'error',
      error: { code: 'multitrack_capacity', fatal: false, message: 'audio frame dropped' },
    });
  }
  await tick(20);
  warnings.restore();

  assert.equal(getSessionSnapshot(meetingUuid).capacityWarnings, 2);
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0].readyState, 1);

  await cleanupMeeting(meetingUuid);
  setWebSocketFactoryForTesting();
});

test('a session.update rejected for lane capacity closes and reconnects', async () => {
  const sockets = useFakeSockets({ autoAck: false });
  const meetingUuid = 'lane-budget-rejected-test';
  initializeLiveScribeSession(meetingUuid);
  await tick(10);
  const errors = captureConsole('error');

  sockets[0].serverSend({
    type: 'error',
    error: {
      code: 'capacity_exceeded',
      fatal: false,
      message: 'multitrack requires 4 lanes but the live concurrency budget has insufficient capacity',
    },
  });
  await tick(40);
  errors.restore();

  assert.equal(sockets[0].readyState, 3, 'the never-ready socket is closed');
  assert.equal(sockets.length, 2, 'and a new session is attempted');

  await cleanupMeeting(meetingUuid);
  setWebSocketFactoryForTesting();
});

test('a session.update rejected as invalid_config fails without retrying', async () => {
  const sockets = useFakeSockets({ autoAck: false });
  const meetingUuid = 'invalid-config-test';
  initializeLiveScribeSession(meetingUuid);
  await tick(10);
  const errors = captureConsole('error');

  sockets[0].serverSend({
    type: 'error',
    error: { code: 'invalid_config', fatal: false, message: 'multitrack lane count must be at least two' },
  });
  await tick(40);
  errors.restore();

  assert.equal(sockets.length, 1, 'the same configuration is not retried');
  assert.equal(getSessionSnapshot(meetingUuid), null);
  assert.ok(errors.lines.some((line) => line.includes('CONNECTION FAILED') && line.includes('input_mode=multitrack')));
  setWebSocketFactoryForTesting();
});

test('fatal capacity_exceeded after the session is ready reconnects', async () => {
  const sockets = useFakeSockets();
  const meetingUuid = 'fatal-capacity-test';
  initializeLiveScribeSession(meetingUuid);
  await tick(10);
  const errors = captureConsole('error');

  sockets[0].serverSend({
    type: 'error',
    error: { code: 'capacity_exceeded', fatal: true, message: 'no capacity' },
  });
  await tick(40);
  errors.restore();

  assert.equal(sockets.length, 2);
  assert.equal(getSessionSnapshot(meetingUuid).ready, true, 'the replacement session became ready');

  await cleanupMeeting(meetingUuid);
  setWebSocketFactoryForTesting();
});

test('server_shutting_down reconnects even on a clean 1000 close', async () => {
  const sockets = useFakeSockets();
  const meetingUuid = 'server-shutdown-test';
  initializeLiveScribeSession(meetingUuid);
  await tick(10);

  sockets[0].serverSend({ type: 'session.closed', reason: 'server_shutting_down' });
  sockets[0].close(1000, '');
  await tick(40);

  assert.equal(sockets.length, 2);

  await cleanupMeeting(meetingUuid);
  setWebSocketFactoryForTesting();
});

class HandshakeRejectedFakeWebSocket extends EventEmitter {
  constructor({ statusCode = 429, headers = {} } = {}) {
    super();
    this.readyState = 0;
    queueMicrotask(() => {
      this.readyState = 3;
      this.emit('unexpected-response', {}, { statusCode, headers, resume() {} });
    });
  }

  send() { /* rejected before session.update could be sent */ }
  close() { /* already closed */ }
  terminate() { /* already closed */ }
}

test('a 429 handshake rejection honors Retry-After as a reconnect floor', async () => {
  let socketsCreated = 0;
  setWebSocketFactoryForTesting(() => {
    socketsCreated += 1;
    if (socketsCreated === 1) {
      return new HandshakeRejectedFakeWebSocket({ statusCode: 429, headers: { 'retry-after': '0.08' } });
    }
    return new FakeWebSocket();
  });
  const errors = captureConsole('error');
  const meetingUuid = 'rate-limited-handshake-test';
  initializeLiveScribeSession(meetingUuid);

  // The 10 ms base backoff alone would have reconnected by now; Retry-After holds it to 80 ms.
  await tick(25);
  assert.equal(socketsCreated, 1);
  await tick(100);
  errors.restore();

  assert.equal(socketsCreated, 2);
  assert.ok(errors.lines.some((line) => line.includes('rate_limited') && line.includes('HTTP 429')));

  await cleanupMeeting(meetingUuid);
  setWebSocketFactoryForTesting();
});

class AlwaysFailingFakeWebSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 0;
    queueMicrotask(() => {
      this.readyState = 3;
      this.emit('close', 1006, Buffer.from('simulated failure'));
    });
  }

  send() { /* never reaches session.updated */ }
  close() { /* already closed */ }
  terminate() { /* already closed */ }
}

test('the session gives up after exhausting reconnect attempts', async () => {
  let socketsCreated = 0;
  setWebSocketFactoryForTesting(() => {
    socketsCreated += 1;
    return new AlwaysFailingFakeWebSocket();
  });
  const errors = captureConsole('error');
  const meetingUuid = 'give-up-test';
  initializeLiveScribeSession(meetingUuid);

  // 1 initial attempt + 3 reconnects at 10/20/40 ms backoff.
  await tick(200);
  errors.restore();

  assert.equal(socketsCreated, 4);
  assert.equal(getSessionSnapshot(meetingUuid), null);
  assert.ok(errors.lines.some((line) => line.includes('CONNECTION FAILED')));
  setWebSocketFactoryForTesting();
});

test('cleanup closes the session and prints a time-sorted, participant-attributed transcript', async () => {
  const sockets = useFakeSockets();
  const meetingUuid = 'cleanup-transcript-test';
  initializeLiveScribeSession(meetingUuid);
  await tick(10);

  // Lane 1's final arrives before lane 0's earlier utterance.
  sockets[0].serverSend({
    type: 'transcription.completed',
    item_id: 'l1:seg_1',
    transcript: 'Thanks, Alpha.',
    audio_start_ms: 0,
    audio_end_ms: 900,
    start_timestamp: 1788334065000,
    end_timestamp: 1788334065900,
    metadata: { user_id: 202, user_name: 'Bravo' },
  });
  sockets[0].serverSend({
    type: 'transcription.completed',
    item_id: 'l0:seg_1',
    transcript: 'Good morning, everyone.',
    audio_start_ms: 0,
    audio_end_ms: 1500,
    start_timestamp: 1788334063000,
    end_timestamp: 1788334064500,
    metadata: { user_id: 101, user_name: 'Alpha' },
  });
  assert.deepEqual(getSessionSnapshot(meetingUuid).lanesSeen, [0, 1]);

  const logs = captureConsole('log');
  await cleanupMeeting(meetingUuid);
  logs.restore();

  assert.ok(sockets[0].wire().some((message) => message.type === 'session.close'));
  const finalLog = logs.lines.find((line) => line.includes('"transcript.final"'));
  assert.ok(finalLog, 'the final transcript is printed');
  const document = JSON.parse(finalLog);
  assert.deepEqual(
    document.utterances.map((item) => [item.participant.user_name, item.text]),
    [['Alpha', 'Good morning, everyone.'], ['Bravo', 'Thanks, Alpha.']]
  );
  assert.equal(getSessionSnapshot(meetingUuid), null);
  setWebSocketFactoryForTesting();
});
