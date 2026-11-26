import crypto from 'crypto';

const DEFAULT_TOKEN_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
const DEFAULT_MEDIA_ACTIVE_WINDOW_MS = 3000;
const MEDIA_TYPES = ['audio', 'video', 'screenshare', 'transcript', 'chat'];

function toBase64Url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function fromBase64Flexible(str) {
  const normalized = String(str || '')
    .trim()
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  return Buffer.from(normalized + padding, 'base64');
}

export function timingSafeEqualString(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length === 0 || b.length === 0) {
    return false;
  }
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  if (aBuf.length !== bBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(aBuf, bBuf);
}

/**
 * Decrypts and verifies the Zoom App `x-zoom-app-context` HTTP header.
 * Zoom encrypts JSON context with AES-256-GCM using SHA-256(clientSecret).
 */
export function decryptZoomAppContext(headerValue, clientSecret) {
  if (!headerValue || !clientSecret) return null;
  try {
    const buf = fromBase64Flexible(headerValue);
    if (buf.length < 1 + 2 + 4 + 16) return null;

    let offset = 0;
    const ivLength = buf.readUInt8(offset);
    offset += 1;
    if (ivLength === 0 || offset + ivLength + 2 > buf.length) return null;
    const iv = buf.subarray(offset, offset + ivLength);
    offset += ivLength;

    const aadLength = buf.readUInt16LE(offset);
    offset += 2;
    if (offset + aadLength + 4 > buf.length) return null;
    const aad = buf.subarray(offset, offset + aadLength);
    offset += aadLength;

    const cipherLength = buf.readUInt32LE(offset);
    offset += 4;
    if (offset + cipherLength + 16 > buf.length) return null;
    const cipherText = buf.subarray(offset, offset + cipherLength);
    offset += cipherLength;

    const authTag = buf.subarray(offset);
    if (authTag.length !== 16) return null;

    const key = crypto.createHash('sha256').update(String(clientSecret)).digest();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    if (aadLength > 0) decipher.setAAD(aad);
    decipher.setAuthTag(authTag);

    const plaintext = Buffer.concat([decipher.update(cipherText), decipher.final()]).toString('utf8');
    const context = JSON.parse(plaintext);
    if (!context || typeof context !== 'object') return null;

    if (context.exp != null) {
      const expMs = Number(context.exp) < 1e12 ? Number(context.exp) * 1000 : Number(context.exp);
      if (Number.isFinite(expMs) && Date.now() > expMs) {
        return null;
      }
    }

    return context;
  } catch {
    return null;
  }
}

export function mintWsAuthToken(claims, signingSecret, ttlMs = DEFAULT_TOKEN_TTL_MS) {
  if (!signingSecret) return '';
  const now = Date.now();
  const payload = {
    mid: claims?.mid ? String(claims.mid) : null,
    uid: claims?.uid ? String(claims.uid) : null,
    iat: now,
    exp: now + ttlMs
  };
  const encodedPayload = toBase64Url(JSON.stringify(payload));
  const signature = toBase64Url(
    crypto.createHmac('sha256', String(signingSecret)).update(encodedPayload).digest()
  );
  return `${encodedPayload}.${signature}`;
}

export function verifyWsAuthToken(token, signingSecret, expectedMeetingUUID = null) {
  if (typeof token !== 'string' || !token.includes('.') || !signingSecret) {
    return { valid: false };
  }
  const parts = token.split('.');
  if (parts.length !== 2) return { valid: false };
  const [encodedPayload, providedSig] = parts;
  if (!encodedPayload || !providedSig) return { valid: false };

  const expectedSig = toBase64Url(
    crypto.createHmac('sha256', String(signingSecret)).update(encodedPayload).digest()
  );
  if (!timingSafeEqualString(providedSig, expectedSig)) {
    return { valid: false };
  }

  try {
    const payload = JSON.parse(fromBase64Flexible(encodedPayload).toString('utf8'));
    if (!payload || typeof payload !== 'object') return { valid: false };
    if (typeof payload.exp !== 'number' || Date.now() > payload.exp) {
      return { valid: false };
    }
    if (expectedMeetingUUID && payload.mid && String(payload.mid) !== String(expectedMeetingUUID)) {
      return { valid: false };
    }
    return { valid: true, claims: payload };
  } catch {
    return { valid: false };
  }
}

export function createRegistrationAuthorizer({
  getActiveConnections,
  staticAuthToken = '',
  signingSecret = '',
  allowPreRtmsRegistration = false
}) {
  return async ({ meetingUUID, userID, token } = {}) => {
    const meetingId = String(meetingUUID || '').trim();
    const userId = String(userID ?? '').trim();
    if (!meetingId || !userId) {
      return { authorized: false };
    }

    const connections = typeof getActiveConnections === 'function' ? getActiveConnections() : [];
    const hasActiveConnection = Array.isArray(connections) && connections.some((conn) =>
      String(conn?.meetingUuid || conn?.rtmsId || '') === meetingId
    );
    if (hasActiveConnection) {
      return { authorized: true, meetingUUID: meetingId, userID: userId, reason: 'active_rtms' };
    }

    if (staticAuthToken && timingSafeEqualString(String(token || ''), String(staticAuthToken))) {
      return { authorized: true, meetingUUID: meetingId, userID: userId, reason: 'static_token' };
    }

    if (token && signingSecret) {
      const verified = verifyWsAuthToken(String(token), signingSecret, meetingId);
      if (verified.valid) {
        return { authorized: true, meetingUUID: meetingId, userID: userId, reason: 'zoom_context_token' };
      }
    }

    if (allowPreRtmsRegistration) {
      return { authorized: true, meetingUUID: meetingId, userID: userId, reason: 'dev_pre_rtms' };
    }

    return { authorized: false };
  };
}

function createEmptyMediaBucket() {
  return {
    totalPackets: 0,
    totalBytes: 0,
    intervalPackets: 0,
    intervalBytes: 0,
    packetsPerSec: 0,
    bytesPerSec: 0,
    fps: 0,
    lastUser: null,
    lastTimestamp: null,
    active: false
  };
}

export class MeetingTelemetryTracker {
  constructor(options = {}) {
    this.activeWindowMs = Number(options.activeWindowMs) || DEFAULT_MEDIA_ACTIVE_WINDOW_MS;
    this.meetings = new Map();
  }

  getOrCreate(meetingId) {
    const key = String(meetingId || '');
    if (!key) return null;
    if (!this.meetings.has(key)) {
      const media = {};
      for (const type of MEDIA_TYPES) {
        media[type] = createEmptyMediaBucket();
      }
      this.meetings.set(key, {
        meetingUuid: key,
        streamId: null,
        rtmsStatus: 'idle',
        startedAt: null,
        activeSpeaker: null,
        participants: new Map(),
        media,
        lastFlushAt: Date.now()
      });
    }
    return this.meetings.get(key);
  }

  markStarted(meetingId, streamId = null) {
    const state = this.getOrCreate(meetingId);
    if (!state) return null;
    state.streamId = streamId || state.streamId;
    state.rtmsStatus = 'active';
    state.startedAt = Date.now();
    return state;
  }

  markStopped(meetingId, streamId = null) {
    const state = this.getOrCreate(meetingId);
    if (!state) return null;
    if (streamId && state.streamId && String(streamId) !== String(state.streamId)) {
      return state;
    }
    state.rtmsStatus = 'stopped';
    state.activeSpeaker = null;
    for (const type of MEDIA_TYPES) {
      state.media[type].active = false;
      state.media[type].packetsPerSec = 0;
      state.media[type].bytesPerSec = 0;
      state.media[type].fps = 0;
      state.media[type].intervalPackets = 0;
      state.media[type].intervalBytes = 0;
    }
    return state;
  }

  recordMedia(meetingId, mediaType, { bytes = 0, userName = null, timestamp = Date.now(), streamId = null } = {}) {
    if (!MEDIA_TYPES.includes(mediaType)) return;
    const state = this.getOrCreate(meetingId);
    if (!state) return;
    if (streamId && !state.streamId) state.streamId = streamId;
    if (state.rtmsStatus === 'idle') state.rtmsStatus = 'active';

    const bucket = state.media[mediaType];
    const safeBytes = Math.max(0, Number(bytes) || 0);
    bucket.totalPackets += 1;
    bucket.totalBytes += safeBytes;
    bucket.intervalPackets += 1;
    bucket.intervalBytes += safeBytes;
    if (userName) bucket.lastUser = userName;
    bucket.lastTimestamp = Number(timestamp) || Date.now();
    bucket.active = true;
  }

  setActiveSpeaker(meetingId, { userId = null, userName = null } = {}) {
    const state = this.getOrCreate(meetingId);
    if (!state) return;
    state.activeSpeaker = {
      userId: userId != null ? String(userId) : null,
      user: userName || (userId != null ? `User ${userId}` : 'Unknown'),
      timestamp: Date.now()
    };
  }

  addParticipants(meetingId, participants = []) {
    const state = this.getOrCreate(meetingId);
    if (!state) return;
    for (const p of participants) {
      const id = p?.user_id ?? p?.userId;
      if (id == null) continue;
      const name = p?.user_name ?? p?.userName ?? `User ${id}`;
      state.participants.set(String(id), { userId: String(id), user: name });
    }
  }

  removeParticipants(meetingId, participants = []) {
    const state = this.getOrCreate(meetingId);
    if (!state) return;
    for (const p of participants) {
      const id = p?.user_id ?? p?.userId;
      if (id == null) continue;
      state.participants.delete(String(id));
    }
  }

  flushInterval(now = Date.now()) {
    const snapshots = [];
    for (const state of this.meetings.values()) {
      const elapsedSec = Math.max((now - state.lastFlushAt) / 1000, 0.25);
      state.lastFlushAt = now;

      const mediaSummary = {};
      for (const type of MEDIA_TYPES) {
        const bucket = state.media[type];
        const packetsPerSec = Number((bucket.intervalPackets / elapsedSec).toFixed(1));
        const bytesPerSec = Math.round(bucket.intervalBytes / elapsedSec);
        const fps = type === 'video' || type === 'screenshare' ? packetsPerSec : 0;
        const active = Boolean(bucket.lastTimestamp && (now - bucket.lastTimestamp) <= this.activeWindowMs);

        bucket.packetsPerSec = packetsPerSec;
        bucket.bytesPerSec = bytesPerSec;
        bucket.fps = fps;
        bucket.active = active;
        bucket.intervalPackets = 0;
        bucket.intervalBytes = 0;

        mediaSummary[type] = {
          totalPackets: bucket.totalPackets,
          totalBytes: bucket.totalBytes,
          packetsPerSec,
          bytesPerSec,
          fps,
          lastUser: bucket.lastUser,
          lastTimestamp: bucket.lastTimestamp,
          active
        };
      }

      snapshots.push({
        type: 'telemetry',
        meetingUuid: state.meetingUuid,
        streamId: state.streamId,
        rtmsStatus: state.rtmsStatus,
        startedAt: state.startedAt,
        activeSpeaker: state.activeSpeaker,
        participants: Array.from(state.participants.values()),
        media: mediaSummary,
        timestamp: now
      });
    }
    return snapshots;
  }

  getSnapshot(meetingId, now = Date.now()) {
    const state = this.meetings.get(String(meetingId || ''));
    if (!state) return null;

    const mediaSummary = {};
    for (const type of MEDIA_TYPES) {
      const bucket = state.media[type];
      mediaSummary[type] = {
        totalPackets: bucket.totalPackets,
        totalBytes: bucket.totalBytes,
        packetsPerSec: bucket.packetsPerSec,
        bytesPerSec: bucket.bytesPerSec,
        fps: bucket.fps,
        lastUser: bucket.lastUser,
        lastTimestamp: bucket.lastTimestamp,
        active: Boolean(bucket.lastTimestamp && (now - bucket.lastTimestamp) <= this.activeWindowMs)
      };
    }

    return {
      type: 'telemetry',
      meetingUuid: state.meetingUuid,
      streamId: state.streamId,
      rtmsStatus: state.rtmsStatus,
      startedAt: state.startedAt,
      activeSpeaker: state.activeSpeaker,
      participants: Array.from(state.participants.values()),
      media: mediaSummary,
      timestamp: now
    };
  }

  removeMeeting(meetingId) {
    this.meetings.delete(String(meetingId || ''));
  }

  clear() {
    this.meetings.clear();
  }
}
