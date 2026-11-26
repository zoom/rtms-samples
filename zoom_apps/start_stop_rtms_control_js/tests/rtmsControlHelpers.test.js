import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import {
  MeetingTelemetryTracker,
  createRegistrationAuthorizer,
  decryptZoomAppContext,
  mintWsAuthToken,
  verifyWsAuthToken
} from '../rtmsControlHelpers.js';
import { TranscriptRevisionStore } from '../../../library/javascript/rtmsManager/utils/TranscriptRevisionStore.js';

function encryptZoomAppContext(payloadObj, clientSecret) {
  const key = crypto.createHash('sha256').update(clientSecret).digest();
  const iv = crypto.randomBytes(12);
  const aad = Buffer.from('zoom-app-aad', 'utf8');
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);
  const plaintext = Buffer.from(JSON.stringify(payloadObj), 'utf8');
  const cipherText = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  const header = Buffer.alloc(1 + iv.length + 2 + aad.length + 4 + cipherText.length + tag.length);
  let offset = 0;
  header.writeUInt8(iv.length, offset); offset += 1;
  iv.copy(header, offset); offset += iv.length;
  header.writeUInt16LE(aad.length, offset); offset += 2;
  aad.copy(header, offset); offset += aad.length;
  header.writeUInt32LE(cipherText.length, offset); offset += 4;
  cipherText.copy(header, offset); offset += cipherText.length;
  tag.copy(header, offset);

  return header.toString('base64url');
}

test('decryptZoomAppContext decrypts valid AES-256-GCM context and rejects wrong secret or expired', () => {
  const secret = 'test-client-secret-123';
  const validHeader = encryptZoomAppContext({ mid: 'meeting-abc', uid: 'user-1', exp: Date.now() + 60_000 }, secret);
  const decoded = decryptZoomAppContext(validHeader, secret);
  assert.equal(decoded.mid, 'meeting-abc');
  assert.equal(decoded.uid, 'user-1');

  assert.equal(decryptZoomAppContext(validHeader, 'wrong-secret'), null);

  const expiredHeader = encryptZoomAppContext({ mid: 'meeting-abc', exp: Date.now() - 10_000 }, secret);
  assert.equal(decryptZoomAppContext(expiredHeader, secret), null);
});

test('mintWsAuthToken and verifyWsAuthToken enforce signature, expiry, and meeting binding', () => {
  const secret = 'signing-secret-xyz';
  const token = mintWsAuthToken({ mid: 'mtg-1', uid: 'u-1' }, secret, 60_000);

  assert.equal(verifyWsAuthToken(token, secret, 'mtg-1').valid, true);
  assert.equal(verifyWsAuthToken(token, secret, 'mtg-other').valid, false);
  assert.equal(verifyWsAuthToken(token, 'other-secret', 'mtg-1').valid, false);

  const expired = mintWsAuthToken({ mid: 'mtg-1' }, secret, -1000);
  assert.equal(verifyWsAuthToken(expired, secret, 'mtg-1').valid, false);
});

test('createRegistrationAuthorizer enforces active RTMS, static token, context token, or dev flag', async () => {
  const secret = 'signing-secret-abc';
  const token = mintWsAuthToken({ mid: 'mtg-2', uid: 'p-2' }, secret, 60_000);

  const authorize = createRegistrationAuthorizer({
    getActiveConnections: () => [{ rtmsId: 'mtg-active' }],
    staticAuthToken: 'static-secret-token',
    signingSecret: secret,
    allowPreRtmsRegistration: false
  });

  const activeRes = await authorize({ meetingUUID: 'mtg-active', userID: 'u1' });
  assert.equal(activeRes.authorized, true);
  assert.equal(activeRes.reason, 'active_rtms');

  const staticRes = await authorize({ meetingUUID: 'mtg-any', userID: 'u1', token: 'static-secret-token' });
  assert.equal(staticRes.authorized, true);
  assert.equal(staticRes.reason, 'static_token');

  const ctxRes = await authorize({ meetingUUID: 'mtg-2', userID: 'u2', token });
  assert.equal(ctxRes.authorized, true);
  assert.equal(ctxRes.reason, 'zoom_context_token');

  const denied = await authorize({ meetingUUID: 'mtg-unknown', userID: 'u3', token: 'bad' });
  assert.equal(denied.authorized, false);
});

test('MeetingTelemetryTracker aggregates per-media rates and resets interval counters on flush', () => {
  const tracker = new MeetingTelemetryTracker({ activeWindowMs: 3000 });
  const t0 = 1_000_000;
  tracker.markStarted('mtg-1', 'stream-1');
  tracker.getOrCreate('mtg-1').lastFlushAt = t0;

  for (let i = 0; i < 25; i++) {
    tracker.recordMedia('mtg-1', 'video', { bytes: 2000, userName: 'Alice', timestamp: t0 + 500 });
  }
  tracker.recordMedia('mtg-1', 'audio', { bytes: 3200, userName: 'mixed', timestamp: t0 + 500 });
  tracker.addParticipants('mtg-1', [{ user_id: 101, user_name: 'Alice' }]);
  tracker.setActiveSpeaker('mtg-1', { userId: 101, userName: 'Alice' });

  const [snap] = tracker.flushInterval(t0 + 1000);
  assert.equal(snap.meetingUuid, 'mtg-1');
  assert.equal(snap.media.video.fps, 25);
  assert.equal(snap.media.video.bytesPerSec, 50000);
  assert.equal(snap.media.video.totalPackets, 25);
  assert.equal(snap.media.audio.totalPackets, 1);
  assert.equal(snap.activeSpeaker.user, 'Alice');
  assert.equal(snap.participants.length, 1);

  const [snap2] = tracker.flushInterval(t0 + 2000);
  assert.equal(snap2.media.video.fps, 0);
  assert.equal(snap2.media.video.totalPackets, 25);
});

test('TranscriptRevisionStore updates revised sentences in place', () => {
  const store = new TranscriptRevisionStore();
  const first = store.apply({
    streamId: 's1',
    rtmsId: 'm1',
    userId: 10,
    userName: 'Alice',
    sentenceId: 42,
    text: 'Hello worl'
  });
  assert.equal(first.action, 'new');
  assert.equal(store.size, 1);

  const revised = store.apply({
    streamId: 's1',
    rtmsId: 'm1',
    userId: 10,
    userName: 'Alice',
    sentenceId: 42,
    isUpdate: true,
    text: 'Hello world!'
  });
  assert.equal(revised.action, 'updated');
  assert.equal(revised.key, first.key);
  assert.equal(revised.sentence.revision, 1);
  assert.equal(revised.sentence.text, 'Hello world!');
  assert.equal(store.size, 1);
});
