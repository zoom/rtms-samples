import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const DEFAULT_TOKEN_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_HISTORY_ENTRIES = 10;

function toBase64Url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function fromBase64Flexible(str) {
  const normalized = String(str || '').trim().replace(/-/g, '+').replace(/_/g, '/');
  const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  return Buffer.from(normalized + padding, 'base64');
}

export function timingSafeEqualString(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a.length || !b.length) return false;
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

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
      if (Number.isFinite(expMs) && Date.now() > expMs) return null;
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
  const expectedSig = toBase64Url(
    crypto.createHmac('sha256', String(signingSecret)).update(encodedPayload).digest()
  );
  if (!timingSafeEqualString(providedSig, expectedSig)) return { valid: false };

  try {
    const payload = JSON.parse(fromBase64Flexible(encodedPayload).toString('utf8'));
    if (!payload || typeof payload !== 'object') return { valid: false };
    if (typeof payload.exp !== 'number' || Date.now() > payload.exp) return { valid: false };
    if (expectedMeetingUUID && payload.mid && String(payload.mid) !== String(expectedMeetingUUID)) {
      return { valid: false };
    }
    return { valid: true, claims: payload };
  } catch {
    return { valid: false };
  }
}

export function createSocketAuthorizer({
  getActiveConnections,
  staticAuthToken = '',
  signingSecret = '',
  allowPreRtmsRegistration = false
}) {
  return ({ meetingUUID, userID, token } = {}) => {
    const meetingId = String(meetingUUID || '').trim();
    const userId = String(userID ?? '').trim();
    if (!meetingId || !userId) return { authorized: false };

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

export function deriveMeetingKey(meetingId) {
  return crypto.createHash('sha256').update(String(meetingId || 'default')).digest('hex').slice(0, 16);
}

export function computeCombinedTrustVerdict(videoEntry = null, audioEntry = null) {
  const vStatus = String(videoEntry?.status || 'unverified').toLowerCase();
  const aStatus = String(audioEntry?.status || 'unverified').toLowerCase();

  const vScore = typeof videoEntry?.realScore === 'number' && Number.isFinite(videoEntry.realScore)
    ? videoEntry.realScore
    : null;
  const aScore = typeof audioEntry?.realScore === 'number' && Number.isFinite(audioEntry.realScore)
    ? audioEntry.realScore
    : null;

  const scores = [vScore, aScore].filter((s) => s !== null);
  const combinedRealScore = scores.length > 0
    ? Number((scores.reduce((acc, s) => acc + s, 0) / scores.length).toFixed(4))
    : null;

  if (vStatus === 'deepfake' || aStatus === 'deepfake') {
    const flagged = [
      vStatus === 'deepfake' ? 'Video' : null,
      aStatus === 'deepfake' ? 'Audio' : null
    ].filter(Boolean).join(' + ');
    return {
      status: 'deepfake',
      tone: 'warning',
      label: `Deepfake Alert (${flagged})`,
      combinedRealScore
    };
  }

  if (vStatus === 'verified' && aStatus === 'verified') {
    return {
      status: 'verified',
      tone: 'verified',
      label: 'Verified (Audio + Video)',
      combinedRealScore
    };
  }

  if (vStatus === 'verified' || aStatus === 'verified') {
    const verifiedModality = vStatus === 'verified' ? 'Video' : 'Audio';
    return {
      status: 'partial',
      tone: 'running',
      label: `Partially Verified (${verifiedModality} only)`,
      combinedRealScore
    };
  }

  if (vStatus === 'error' || aStatus === 'error') {
    return {
      status: 'error',
      tone: 'warning',
      label: 'Verification Error',
      combinedRealScore
    };
  }

  if (vStatus === 'running' || aStatus === 'running') {
    return {
      status: 'running',
      tone: 'running',
      label: 'Analyzing Media...',
      combinedRealScore
    };
  }

  return {
    status: 'unverified',
    tone: 'pending',
    label: 'Unverified',
    combinedRealScore
  };
}

export class MeetingSession {
  constructor({
    meetingId,
    hlsRootDir,
    clipsRootDir,
    createHlsPipeline,
    createAudioClipBuffer,
    videoVendorName,
    audioVendorName
  }) {
    this.meetingId = String(meetingId);
    this.meetingKey = deriveMeetingKey(this.meetingId);
    this.hlsDir = path.join(hlsRootDir, this.meetingKey);
    this.videoClipDir = path.join(clipsRootDir, this.meetingKey, 'video');
    this.audioClipDir = path.join(clipsRootDir, this.meetingKey, 'audio');
    this.playlistUrl = `/hls/${this.meetingKey}/stream.m3u8`;

    this.videoVendorName = videoVendorName || 'Video Detector';
    this.audioVendorName = audioVendorName || 'Audio Detector';

    this.activeStreamId = null;
    this.rtmsStatus = 'stopped';
    this.selectionGeneration = 0;

    this.participants = new Map();
    this.videoOnParticipants = new Map();
    this.activeSpeaker = null;
    this.selectedVideoUser = null;
    this.zoomParticipants = new Map();
    this.participantMappings = new Map();
    this.participantVerification = new Map();

    this.hlsReady = false;
    this.deepfakeDetectionEnabled = false;
    this.deepfakeStatus = 'unverified';
    this.lastDeepfakeResult = null;
    this.lastInferenceClipKey = null;
    this.inferenceInFlight = false;

    this.audioDeepfakeDetectionEnabled = false;
    this.audioDeepfakeStatus = 'unverified';
    this.lastAudioDeepfakeResult = null;
    this.lastAudioInferenceClipKey = null;
    this.audioInferenceInFlight = false;

    this.hlsPipeline = createHlsPipeline({
      hlsDir: this.hlsDir,
      clipDir: this.videoClipDir,
      playlistUrl: this.playlistUrl,
      session: this
    });
    this.audioClipBuffer = createAudioClipBuffer({
      clipDir: this.audioClipDir,
      session: this
    });
  }

  bumpSelectionGeneration() {
    this.selectionGeneration += 1;
    return this.selectionGeneration;
  }

  isJobCurrent(job) {
    if (!job) return false;
    return (
      Boolean(this.activeStreamId) &&
      String(this.activeStreamId) === String(job.streamId) &&
      this.selectedVideoUser?.userId != null &&
      String(this.selectedVideoUser.userId) === String(job.userId) &&
      this.selectionGeneration === job.selectionGeneration
    );
  }

  resetDeepfakeState(status = 'unverified') {
    this.deepfakeDetectionEnabled = false;
    this.deepfakeStatus = status;
    this.lastDeepfakeResult = null;
    this.lastInferenceClipKey = null;
  }

  resetAudioDeepfakeState(status = 'unverified') {
    this.audioDeepfakeDetectionEnabled = false;
    this.audioDeepfakeStatus = status;
    this.lastAudioDeepfakeResult = null;
    this.lastAudioInferenceClipKey = null;
    this.audioClipBuffer?.reset();
  }

  recordParticipantVerification(userId, mediaType, status, result = null, participant = null) {
    if (userId == null || String(userId).trim() === '') return null;
    const key = String(userId);
    const existing = this.participantVerification.get(key) || {
      userId,
      userName: null,
      video: null,
      audio: null,
      history: { video: [], audio: [] }
    };

    const mediaKey = mediaType === 'audio' ? 'audio' : 'video';
    const previousMedia = existing[mediaKey] || {};
    const defaultVendor = mediaKey === 'audio' ? this.audioVendorName : this.videoVendorName;
    const updatedMedia = {
      status: status || 'unverified',
      vendorName: result?.vendorName || previousMedia.vendorName || defaultVendor,
      realScore: result?.realScore ?? null,
      fakeScore: result?.fakeScore ?? null,
      clipName: result?.clip?.name || previousMedia.clipName || null,
      processingMs: result?.processingMs ?? null,
      updatedAt: Date.now()
    };

    const history = {
      video: Array.isArray(existing.history?.video) ? [...existing.history.video] : [],
      audio: Array.isArray(existing.history?.audio) ? [...existing.history.audio] : []
    };

    if (result && !result.skipped && typeof result.realScore === 'number' && Number.isFinite(result.realScore)) {
      history[mediaKey].push({
        status: updatedMedia.status,
        realScore: Number(result.realScore.toFixed(4)),
        fakeScore: typeof result.fakeScore === 'number' ? Number(result.fakeScore.toFixed(4)) : null,
        timestamp: result.completedAt || Date.now()
      });
      if (history[mediaKey].length > MAX_HISTORY_ENTRIES) {
        history[mediaKey].splice(0, history[mediaKey].length - MAX_HISTORY_ENTRIES);
      }
    }

    const nextVideo = mediaKey === 'video' ? updatedMedia : existing.video;
    const nextAudio = mediaKey === 'audio' ? updatedMedia : existing.audio;
    const combined = computeCombinedTrustVerdict(nextVideo, nextAudio);

    const record = {
      userId,
      userName: participant?.userName ?? participant?.user_name ?? existing.userName ?? null,
      video: nextVideo,
      audio: nextAudio,
      combined,
      history,
      updatedAt: Date.now()
    };

    this.participantVerification.set(key, record);
    return record;
  }

  snapshot(runtimeConfig = {}) {
    const selectedVerification = this.selectedVideoUser?.userId != null
      ? this.participantVerification.get(String(this.selectedVideoUser.userId)) || null
      : null;

    return {
      rtmsStatus: this.rtmsStatus,
      streamId: this.activeStreamId,
      meetingId: this.meetingId,
      meetingKey: this.meetingKey,
      hlsReady: this.hlsReady,
      hlsUrl: this.hlsReady ? this.playlistUrl : null,
      participants: Array.from(this.participants.values()),
      videoOnParticipants: Array.from(this.videoOnParticipants.values()),
      activeSpeaker: this.activeSpeaker,
      selectedVideoUser: this.selectedVideoUser,
      zoomParticipants: Array.from(this.zoomParticipants.values()),
      participantMappings: Object.fromEntries(this.participantMappings.entries()),
      participantVerification: Object.fromEntries(this.participantVerification.entries()),
      combinedVerdict: selectedVerification?.combined || computeCombinedTrustVerdict(null, null),
      selectedConfidenceHistory: selectedVerification?.history || { video: [], audio: [] },
      lastDeepfakeResult: this.lastDeepfakeResult,
      lastAudioDeepfakeResult: this.lastAudioDeepfakeResult,
      deepfakeDetectionEnabled: this.deepfakeDetectionEnabled,
      deepfakeStatus: this.deepfakeStatus,
      audioDeepfakeDetectionEnabled: this.audioDeepfakeDetectionEnabled,
      audioDeepfakeStatus: this.audioDeepfakeStatus,
      runtimeConfig
    };
  }

  destroy() {
    this.bumpSelectionGeneration();
    this.hlsPipeline?.stop({ clean: true, emitReset: false, reason: 'destroy' });
    this.audioClipBuffer?.reset();
    try {
      fs.rmSync(this.hlsDir, { recursive: true, force: true });
      fs.rmSync(path.dirname(this.videoClipDir), { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors on shutdown.
    }
  }
}

export class SessionManager {
  constructor({
    hlsRootDir,
    clipsRootDir,
    createHlsPipeline,
    createAudioClipBuffer,
    videoVendorName,
    audioVendorName
  }) {
    this.hlsRootDir = hlsRootDir;
    this.clipsRootDir = clipsRootDir;
    this.createHlsPipeline = createHlsPipeline;
    this.createAudioClipBuffer = createAudioClipBuffer;
    this.videoVendorName = videoVendorName;
    this.audioVendorName = audioVendorName;

    this.sessionsByMeetingId = new Map();
    this.sessionsByMeetingKey = new Map();
    this.meetingIdByStreamId = new Map();
  }

  getOrCreateSession(meetingId) {
    const key = String(meetingId || '').trim();
    if (!key) return null;
    if (!this.sessionsByMeetingId.has(key)) {
      const session = new MeetingSession({
        meetingId: key,
        hlsRootDir: this.hlsRootDir,
        clipsRootDir: this.clipsRootDir,
        createHlsPipeline: this.createHlsPipeline,
        createAudioClipBuffer: this.createAudioClipBuffer,
        videoVendorName: this.videoVendorName,
        audioVendorName: this.audioVendorName
      });
      this.sessionsByMeetingId.set(key, session);
      this.sessionsByMeetingKey.set(session.meetingKey, session);
    }
    return this.sessionsByMeetingId.get(key);
  }

  getSessionByMeetingId(meetingId) {
    return this.sessionsByMeetingId.get(String(meetingId || '').trim()) || null;
  }

  getSessionByMeetingKey(meetingKey) {
    return this.sessionsByMeetingKey.get(String(meetingKey || '').trim()) || null;
  }

  bindStream(streamId, meetingId) {
    if (!streamId || !meetingId) return null;
    const session = this.getOrCreateSession(meetingId);
    this.meetingIdByStreamId.set(String(streamId), session.meetingId);
    return session;
  }

  getSessionByStreamId(streamId) {
    if (!streamId) return null;
    const meetingId = this.meetingIdByStreamId.get(String(streamId));
    return meetingId ? this.getSessionByMeetingId(meetingId) : null;
  }

  unbindStream(streamId) {
    if (streamId) this.meetingIdByStreamId.delete(String(streamId));
  }

  allSessions() {
    return Array.from(this.sessionsByMeetingId.values());
  }

  destroyAll() {
    for (const session of this.sessionsByMeetingId.values()) {
      session.destroy();
    }
    this.sessionsByMeetingId.clear();
    this.sessionsByMeetingKey.clear();
    this.meetingIdByStreamId.clear();
  }
}
