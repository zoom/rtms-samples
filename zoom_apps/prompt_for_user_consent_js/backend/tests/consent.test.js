process.env.NODE_ENV = 'test';
process.env.ZOOM_APP_CLIENT_SECRET = 'test_' + 'a'.repeat(24);
process.env.SESSION_SECRET = 'test_' + 'b'.repeat(24);
process.env.INTERNAL_WEBHOOK_TOKEN = 'test_' + 'c'.repeat(24);

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const redisUtil = require('../src/utils/redis');
const { isEncryptionEnabled, looksEncrypted } = require('../src/utils/encryption');
const ConsentManager = require('../src/services/ConsentManager');
const {
  decryptZoomAppContext,
  mintContextToken,
  verifyContextToken,
  requireHostRole,
  verifySocketJoin
} = require('../src/middleware/security');
const webhooks = require('../src/services/WebhookHandlers');

function createInMemoryRedis() {
  const store = new Map();
  return {
    isOpen: true,
    store,
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async set(key, value) {
      store.set(key, value);
      return 'OK';
    },
    async del(key) {
      store.delete(key);
      return 1;
    }
  };
}

function encryptZoomAppContextForTest(payloadObj, clientSecret) {
  const iv = crypto.randomBytes(12);
  const aad = Buffer.from('zoom-aad', 'utf8');
  const key = crypto.createHash('sha256').update(clientSecret).digest();
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);
  const plaintext = Buffer.from(JSON.stringify(payloadObj), 'utf8');
  const cipherText = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  const ivLen = Buffer.alloc(1);
  ivLen.writeUInt8(iv.length, 0);
  const aadLen = Buffer.alloc(2);
  aadLen.writeUInt16LE(aad.length, 0);
  const cipherLen = Buffer.alloc(4);
  cipherLen.writeUInt32LE(cipherText.length, 0);

  return Buffer.concat([ivLen, iv, aadLen, aad, cipherLen, cipherText, tag]).toString('base64');
}

test('Redis encryption encrypts stored consent state when ENCRYPTION_KEY is configured and falls back cleanly when unset', async () => {
  const mockRedis = createInMemoryRedis();
  redisUtil.setRedisClient(mockRedis);

  // Encrypted mode
  process.env.ENCRYPTION_KEY = '0'.repeat(32);
  assert.equal(isEncryptionEnabled(), true);

  await redisUtil.saveConsentState('m-enc', {
    meetingId: 'm-enc',
    participants: [{ participantUUID: 'u1', screenName: 'Alice', consentStatus: 'agreed' }],
    rtmsStatus: 'running',
    unanimousConsent: true
  });

  const rawStored = mockRedis.store.get('consent:m-enc');
  assert.equal(looksEncrypted(rawStored), true);
  assert.equal(rawStored.includes('Alice'), false);

  const loaded = await redisUtil.getConsentState('m-enc');
  assert.equal(loaded.participants[0].screenName, 'Alice');
  assert.equal(loaded.rtmsStatus, 'running');

  // Fallback unencrypted mode
  delete process.env.ENCRYPTION_KEY;
  delete process.env.REDIS_ENCRYPTION_KEY;
  await redisUtil.saveConsentState('m-plain', {
    meetingId: 'm-plain',
    participants: [{ participantUUID: 'u2', screenName: 'Bob', consentStatus: 'pending' }]
  });
  const rawPlain = mockRedis.store.get('consent:m-plain');
  assert.equal(rawPlain.startsWith('{'), true);
  const loadedPlain = await redisUtil.getConsentState('m-plain');
  assert.equal(loadedPlain.participants[0].screenName, 'Bob');
});

test('ConsentManager state machine: unanimous start, newcomer pause, non-consenting leave resume, decline stop, and audit trail', async () => {
  const mockRedis = createInMemoryRedis();
  redisUtil.setRedisClient(mockRedis);
  delete process.env.ENCRYPTION_KEY;
  delete process.env.REDIS_ENCRYPTION_KEY;

  const meetingId = 'meeting-state-1';

  // Sync two participants
  const sync1 = await ConsentManager.syncParticipants(meetingId, [
    { participantUUID: 'u1', screenName: 'Host', role: 'host', isHost: true },
    { participantUUID: 'u2', screenName: 'Guest', role: 'attendee' }
  ]);
  assert.equal(sync1.state.unanimousConsent, false);
  assert.equal(sync1.state.rtmsStatus, 'stopped');

  // Both agree -> RTMS starts
  await ConsentManager.submitConsent(meetingId, {
    participantId: 'u1',
    participantName: 'Host',
    consentStatus: 'agreed'
  });
  const res2 = await ConsentManager.submitConsent(meetingId, {
    participantId: 'u2',
    participantName: 'Guest',
    consentStatus: 'agreed'
  });
  assert.equal(res2.state.unanimousConsent, true);
  assert.equal(res2.state.rtmsStatus, 'running');
  assert.equal(res2.statusChanged, true);

  // New participant joins -> RTMS pauses
  const joinRes = await ConsentManager.addParticipant(meetingId, {
    participantUUID: 'u3',
    screenName: 'Latecomer',
    role: 'attendee'
  });
  assert.equal(joinRes.state.rtmsStatus, 'paused');
  assert.equal(joinRes.state.unanimousConsent, false);
  assert.equal(joinRes.statusChanged, true);

  // Non-consenting participant leaves -> RTMS automatically resumes
  const leaveRes = await ConsentManager.removeParticipant(meetingId, 'u3');
  assert.equal(leaveRes.state.unanimousConsent, true);
  assert.equal(leaveRes.state.rtmsStatus, 'running');
  assert.equal(leaveRes.statusChanged, true);

  // Sync detects an unconsented newcomer -> pauses RTMS
  const syncNewcomer = await ConsentManager.syncParticipants(meetingId, [
    { participantUUID: 'u1', screenName: 'Host', role: 'host', isHost: true },
    { participantUUID: 'u2', screenName: 'Guest', role: 'attendee' },
    { participantUUID: 'u4', screenName: 'Sneaky', role: 'attendee' }
  ]);
  assert.equal(syncNewcomer.state.unanimousConsent, false);
  assert.equal(syncNewcomer.state.rtmsStatus, 'paused');

  // Participant declines while paused -> RTMS immediately stops
  const declineRes = await ConsentManager.submitConsent(meetingId, {
    participantId: 'u4',
    participantName: 'Sneaky',
    consentStatus: 'disagreed'
  });
  assert.equal(declineRes.state.rtmsStatus, 'stopped');
  assert.equal(declineRes.statusChanged, true);
  assert.ok(declineRes.state.auditTrail.length >= 6);

  // Audit CSV export
  const csv = ConsentManager.formatAuditTrailCsv(declineRes.state.auditTrail);
  assert.ok(csv.startsWith('id,timestamp,eventType,policyMode,rtmsStatus'));
  assert.ok(csv.includes('consent_declined'));
  assert.ok(csv.includes('rtms_resumed'));
});

test('ConsentManager per-participant redaction policy mode allows consented speakers and redacts unconsented ones', async () => {
  const mockRedis = createInMemoryRedis();
  redisUtil.setRedisClient(mockRedis);

  const meetingId = 'meeting-redact-1';
  await ConsentManager.syncParticipants(meetingId, [
    { participantUUID: 'u1', participantID: '101', screenName: 'Alice', role: 'host' },
    { participantUUID: 'u2', participantID: '102', screenName: 'Bob', role: 'attendee' }
  ]);
  await ConsentManager.setPolicyMode(meetingId, 'redact');
  const { state } = await ConsentManager.submitConsent(meetingId, {
    participantId: 'u1',
    participantName: 'Alice',
    consentStatus: 'agreed'
  });

  assert.equal(state.policyMode, 'redact');
  assert.equal(state.rtmsStatus, 'running');
  assert.equal(ConsentManager.evaluateTranscriptPolicy(state, { userName: 'Alice' }).action, 'allow');
  assert.equal(ConsentManager.evaluateTranscriptPolicy(state, { userName: 'Bob' }).action, 'redact');
});

test('Zoom App context verification, host-role enforcement, and Socket.IO join verification', () => {
  const secret = process.env.ZOOM_APP_CLIENT_SECRET;
  const hostCtx = encryptZoomAppContextForTest(
    { mid: 'meet-123', uid: 'user-host', role: 'host', exp: Date.now() + 60_000 },
    secret
  );
  const guestCtx = encryptZoomAppContextForTest(
    { mid: 'meet-123', uid: 'user-guest', role: 'attendee', exp: Date.now() + 60_000 },
    secret
  );

  const decoded = decryptZoomAppContext(hostCtx, secret);
  assert.equal(decoded.mid, 'meet-123');
  assert.equal(decoded.role, 'host');

  const token = mintContextToken(decoded);
  const verifiedToken = verifyContextToken(token);
  assert.equal(verifiedToken.mid, 'meet-123');

  // requireHostRole allows host and rejects attendee / missing context
  let nextCalled = false;
  let statusCode = 200;
  const resMock = {
    status(code) { statusCode = code; return this; },
    json() { return this; }
  };

  requireHostRole({ headers: { 'x-zoom-app-context': hostCtx }, body: { meetingId: 'meet-123' } }, resMock, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, true);

  nextCalled = false;
  statusCode = 200;
  requireHostRole({ headers: { 'x-zoom-app-context': guestCtx }, body: { meetingId: 'meet-123' } }, resMock, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, false);
  assert.equal(statusCode, 403);

  // Socket join verification
  assert.equal(verifySocketJoin({ meetingId: 'meet-123', contextHeader: hostCtx, clientSecret: secret }).authorized, true);
  assert.equal(verifySocketJoin({ meetingId: 'other-meet', contextHeader: hostCtx, clientSecret: secret }).authorized, false);
  assert.equal(verifySocketJoin({ meetingId: 'meet-123', contextHeader: 'bad', clientSecret: secret }).authorized, false);
});

test('Webhooks: server-side consent gate blocks unconsented rtms_started, chat consent works without TypeErrors, meeting.ended cleans up Redis', async () => {
  const mockRedis = createInMemoryRedis();
  redisUtil.setRedisClient(mockRedis);

  const broadcasts = [];
  webhooks.setWebSocketServer({
    broadcastConsentUpdate(meetingId, state) {
      broadcasts.push({ type: 'consent', meetingId, state });
    },
    broadcastRTMSStatus(meetingId, status, reason) {
      broadcasts.push({ type: 'rtms', meetingId, status, reason });
    }
  });

  const meetingId = 'meeting-wh-1';
  await ConsentManager.syncParticipants(meetingId, [
    { participantUUID: 'u1', screenName: 'Alice', role: 'host' }
  ]);

  // 1. RTMS started before consent -> blocked server-side!
  const blocked = await webhooks.handleRTMSStarted({
    meeting_uuid: meetingId,
    rtms_stream_id: 'stream-1',
    server_urls: 'wss://example.zoom.us'
  });
  assert.equal(blocked.forwarded, false);
  assert.equal(blocked.reason, 'consent_gate_blocked');

  // 2. Chat consent ("I consent") updates state & broadcasts cleanly
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200, text: async () => '' });
  try {
    const updated = await webhooks.handleChatMessage({
      object: {
        uuid: meetingId,
        chat_message: {
          sender_name: 'Alice',
          message_content: 'I consent to recording'
        }
      }
    });
    assert.equal(updated.unanimousConsent, true);
    assert.equal(updated.rtmsStatus, 'running');
    assert.ok(broadcasts.some((b) => b.type === 'consent' && b.meetingId === meetingId));

    // 3. Now RTMS started passes gate and forwards
    const allowed = await webhooks.handleRTMSStarted({
      meeting_uuid: meetingId,
      rtms_stream_id: 'stream-1',
      server_urls: 'wss://example.zoom.us'
    });
    assert.equal(allowed.forwarded, true);

    // 4. meeting.ended deletes Redis consent state
    await webhooks.handleMeetingEnded({ object: { uuid: meetingId } });
    assert.equal(mockRedis.store.has(`consent:${meetingId}`), false);
  } finally {
    global.fetch = originalFetch;
  }
});
