import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.ZOOM_API_KEY ||= 'test-api-key';
process.env.ZOOM_API_SECRET ||= 'test-api-secret';
process.env.SCRIBE_POOL_SIZE = '3';
process.env.SCRIBE_PENDING_AUDIO_MAX_BYTES = '160000';
process.env.SCRIBE_HEARTBEAT_IDLE_MS = '25';
process.env.SCRIBE_HEARTBEAT_AUDIO_MS = '20';
process.env.SCRIBE_RECONNECT_DELAY_MS = '10';
process.env.SCRIBE_VOCABULARY_JSON = JSON.stringify({
  phrases: ['AIAGW', 'Zoom AI Companion'],
  pronunciations: [{ phrase: 'AIAGW', pronunciation: 'A I A gateway' }],
  aliases: [{
    canonical: 'Zoom AI Companion',
    variants: ['AI Companion', 'Zoom Companion'],
  }],
});

const {
  cleanupMeeting,
  buildDiarizedTranscript,
  buildSessionUpdatePayload,
  calculateTranscriptEpochMs,
  formatNamedUtterance,
  getPoolSnapshot,
  initializeLiveScribeSession,
  parseVocabulary,
  resolveTranscriptAttribution,
  sendAudioChunk,
  setWebSocketFactoryForTesting,
  writeDiarizedTranscript,
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
  assert.deepEqual(payload.config.vocabulary, {
    phrases: ['AIAGW', 'Zoom AI Companion'],
    pronunciations: [{ phrase: 'AIAGW', pronunciation: 'A I A gateway' }],
    aliases: [{
      canonical: 'Zoom AI Companion',
      variants: ['AI Companion', 'Zoom Companion'],
    }],
  });
});

test('vocabulary is optional and invalid entries are rejected', () => {
  assert.equal(parseVocabulary(''), null);
  assert.equal(parseVocabulary('{}'), null);
  assert.throws(
    () => parseVocabulary('{invalid'),
    /must be valid JSON/
  );
  assert.throws(
    () => parseVocabulary(JSON.stringify({ phrases: [''] })),
    /phrases must be an array of non-empty strings/
  );
  assert.throws(
    () => parseVocabulary(JSON.stringify({ aliases: [{ canonical: 'Zoom' }] })),
    /aliases must contain a canonical string and non-empty variants array/
  );
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

test('named utterance uses the RTMS participant identity without a synthetic speaker label', () => {
  const utterance = formatNamedUtterance('meeting-uuid', {
    userId: 16778240,
    userName: 'Participant Name',
    startTimeEpochMs: 1785905379734,
    endTimeEpochMs: 1785905380730,
    receivedAt: 1785905380912,
    text: 'This is a named utterance.',
  });

  assert.deepEqual(utterance, {
    event: 'transcript.utterance',
    source_event: 'transcription.completed',
    meeting_uuid: 'meeting-uuid',
    participant: {
      user_id: 16778240,
      user_name: 'Participant Name',
    },
    start_time: 1785905379734,
    end_time: 1785905380730,
    received_time: 1785905380912,
    text: 'This is a named utterance.',
  });
  assert.equal('speaker' in utterance, false);
  assert.equal('is_final' in utterance, false);
});

test('diarized transcript is saved as private JSON with a sanitized file name', async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'scribe-diarization-'));
  const transcript = [{
    userId: 16778240,
    userName: 'Participant Name',
    startTimeEpochMs: 1785905379734,
    endTimeEpochMs: 1785905380730,
    receivedAt: 1785905380912,
    text: 'Saved utterance.',
  }];

  try {
    const generatedAt = 1785905381000;
    const filePath = await writeDiarizedTranscript(
      outputDir,
      'meeting/uuid+',
      transcript,
      generatedAt
    );
    const saved = JSON.parse(await readFile(filePath, 'utf8'));
    const fileStats = await stat(filePath);

    assert.equal(path.dirname(filePath), outputDir);
    assert.match(path.basename(filePath), /^meeting_uuid_-.*\.json$/);
    assert.equal(fileStats.mode & 0o777, 0o600);
    assert.deepEqual(saved, buildDiarizedTranscript('meeting/uuid+', transcript, generatedAt));
    assert.deepEqual(saved.utterances[0].participant, {
      user_id: 16778240,
      user_name: 'Participant Name',
    });
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
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

  assert.equal(sockets.length, 2);
  sockets[0].close(1000, 'server session ended');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(sockets.length, 3);

  await cleanupMeeting(meetingUuid);
  setWebSocketFactoryForTesting();
});

test('two sockets start eagerly, the third is lazy, and excess participants are excluded', async () => {
  let socketsCreated = 0;
  setWebSocketFactoryForTesting(() => {
    socketsCreated += 1;
    return new FakeWebSocket();
  });
  const meetingUuid = 'pool-test-meeting';
  initializeLiveScribeSession(meetingUuid);
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(socketsCreated, 2);

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
  assert.equal(snapshot.connectedSlots, 3);
  assert.equal(snapshot.excludedParticipants, 1);
  assert.equal(snapshot.waitingParticipants, 0);

  await new Promise((resolve) => setTimeout(resolve, 40));
  const stickySnapshot = getPoolSnapshot(meetingUuid);
  assert.deepEqual(
    stickySnapshot.slots.map((slot) => slot.userId),
    [1, 2, 3]
  );
  assert.ok(!stickySnapshot.slots.some((slot) => slot.userId === 4));

  await cleanupMeeting(meetingUuid);
  setWebSocketFactoryForTesting();
});
