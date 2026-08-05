import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

process.env.ZOOM_API_KEY ||= 'test-api-key';
process.env.ZOOM_API_SECRET ||= 'test-api-secret';
process.env.SCRIBE_RELEASE_PAUSE_MS = '30';
process.env.SCRIBE_DRAIN_TIMEOUT_MS = '100';
process.env.SCRIBE_SWITCH_SILENCE_MS = '10';
process.env.SCRIBE_HEARTBEAT_IDLE_MS = '25';
process.env.SCRIBE_HEARTBEAT_AUDIO_MS = '20';
process.env.SCRIBE_RECONNECT_DELAY_MS = '10';

const {
  cleanupMeeting,
  buildSessionUpdatePayload,
  calculateTranscriptEpochMs,
  getPoolSnapshot,
  initializeLiveScribeSession,
  isSpeechAudio,
  resolveTranscriptAttribution,
  sendAudioChunk,
  setWebSocketFactoryForTesting,
} = await import('../scribeClient.js');

class FakeWebSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 0;
    this.audioCursorMs = 0;
    queueMicrotask(() => {
      this.readyState = 1;
      this.emit('open');
    });
  }

  send(data) {
    if (Buffer.isBuffer(data)) {
      const startMs = this.audioCursorMs;
      this.audioCursorMs += data.length / 32000 * 1000;
      const endMs = this.audioCursorMs;
      queueMicrotask(() => this.emit('message', Buffer.from(JSON.stringify({
        type: 'transcription.completed',
        transcript: '',
        audio_start_ms: startMs,
        audio_end_ms: endMs,
      })), false));
      return;
    }
    const message = JSON.parse(String(data));
    if (message.type === 'session.update') {
      queueMicrotask(() => this.emit('message', Buffer.from(JSON.stringify({
        type: 'session.updated',
      })), false));
    }
    if (message.type === 'session.close') {
      queueMicrotask(() => this.emit('message', Buffer.from(JSON.stringify({
        type: 'session.closed',
        reason: 'test',
      })), false));
    }
  }

  close(code = 1000, reason = '') {
    this.readyState = 3;
    queueMicrotask(() => this.emit('close', code, Buffer.from(reason)));
  }

  terminate() {
    this.close(1006, 'terminated');
  }
}

test('session update includes configured ASR options', () => {
  const payload = buildSessionUpdatePayload();
  assert.equal(payload.type, 'session.update');
  assert.equal(payload.audio.format, 'pcm16');
  assert.equal(typeof payload.config.diarization, 'boolean');
  assert.equal(typeof payload.config.word_time_offsets, 'boolean');
});

test('transcript is attributed to the lease with the largest audio overlap', () => {
  const spans = [
    {
      startMs: 1000,
      endMs: 1800,
      leaseId: 'scribe-1-lease-1',
      userId: 101,
      userName: 'First Speaker',
    },
    {
      startMs: 2200,
      endMs: 3400,
      leaseId: 'scribe-1-lease-2',
      userId: 202,
      userName: 'Second Speaker',
    },
  ];

  const result = resolveTranscriptAttribution(spans, 2100, 3000);
  assert.equal(result.leaseId, 'scribe-1-lease-2');
  assert.equal(result.userName, 'Second Speaker');
});

test('transcript outside known lease ranges remains unattributed', () => {
  const result = resolveTranscriptAttribution([
    { startMs: 1000, endMs: 1500, leaseId: 'lease-1' },
  ], 2000, 2500);
  assert.equal(result, null);
});

test('transcript start and end epochs are derived from an RTMS timestamp', () => {
  const attribution = {
    startMs: 2000,
    rtmsTimestamp: 1778000000123000,
    receivedAt: 1778000000999,
  };

  assert.equal(calculateTranscriptEpochMs(attribution, 2250), 1778000000373);
  assert.equal(calculateTranscriptEpochMs(attribution, 2750), 1778000000873);
  assert.equal(calculateTranscriptEpochMs({ ...attribution, rtmsTimestamp: 1778000000123 }, 2250), 1778000000373);
  assert.equal(calculateTranscriptEpochMs(null, 2250), null);
});

test('speech activity distinguishes silent PCM from voiced PCM', () => {
  const silence = Buffer.alloc(3200);
  const speech = Buffer.alloc(3200);
  for (let offset = 0; offset < speech.length; offset += 2) speech.writeInt16LE(1000, offset);
  assert.equal(isSpeechAudio(silence, 250), false);
  assert.equal(isSpeechAudio(speech, 250), true);
});

test('server-initiated normal closure reconnects the pool slot', async () => {
  const sockets = [];
  setWebSocketFactoryForTesting(() => {
    const socket = new FakeWebSocket();
    sockets.push(socket);
    return socket;
  });
  const meetingUuid = 'normal-close-reconnect-test';
  initializeLiveScribeSession(meetingUuid);
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(sockets.length, 3);
  sockets[0].close(1000, 'server session ended');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(sockets.length, 4);

  await cleanupMeeting(meetingUuid);
  setWebSocketFactoryForTesting();
});

test('three sockets lease three participants and queue the fourth', async () => {
  let socketsCreated = 0;
  setWebSocketFactoryForTesting(() => {
    socketsCreated += 1;
    return new FakeWebSocket();
  });
  const meetingUuid = 'pool-test-meeting';
  initializeLiveScribeSession(meetingUuid);
  await new Promise((resolve) => setTimeout(resolve, 10));

  for (let userId = 1; userId <= 4; userId += 1) {
    const audio = Buffer.alloc(3200);
    for (let offset = 0; offset < audio.length; offset += 2) audio.writeInt16LE(1000, offset);
    sendAudioChunk(audio, meetingUuid, {
      userId,
      userName: `Speaker ${userId}`,
      timestamp: Date.now(),
    });
  }

  const snapshot = getPoolSnapshot(meetingUuid);
  assert.equal(socketsCreated, 3);
  assert.equal(snapshot.slots.filter((slot) => slot.state === 'assigned').length, 3);
  assert.equal(snapshot.waitingParticipants, 1);

  await new Promise((resolve) => setTimeout(resolve, 40));
  const reassignedSnapshot = getPoolSnapshot(meetingUuid);
  assert.equal(reassignedSnapshot.waitingParticipants, 0);
  assert.ok(reassignedSnapshot.slots.some((slot) => slot.userId === 4));

  await cleanupMeeting(meetingUuid);
  setWebSocketFactoryForTesting();
});
