import crypto from 'crypto';

const DEFAULT_TOKEN_TTL_MS = 15 * 60 * 1000;

export function timingSafeEqualString(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length === 0 || bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function encryptZoomAppContext(payload, clientSecret) {
  if (!clientSecret) throw new Error('clientSecret is required');
  const iv = crypto.randomBytes(12);
  const aad = Buffer.from('zoom-app-context', 'utf8');
  const key = crypto.createHash('sha256').update(clientSecret, 'utf8').digest();
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);

  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  const cipherText = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  const ivLenBuf = Buffer.alloc(1);
  ivLenBuf.writeUInt8(iv.length, 0);

  const aadLenBuf = Buffer.alloc(2);
  aadLenBuf.writeUInt16LE(aad.length, 0);

  const cipherLenBuf = Buffer.alloc(4);
  cipherLenBuf.writeUInt32LE(cipherText.length, 0);

  return Buffer.concat([ivLenBuf, iv, aadLenBuf, aad, cipherLenBuf, cipherText, tag]).toString('base64url');
}

export function decryptZoomAppContext(headerValue, clientSecret) {
  if (!headerValue || typeof headerValue !== 'string' || !clientSecret) {
    return null;
  }

  try {
    const normalized = headerValue.replace(/-/g, '+').replace(/_/g, '/');
    const raw = Buffer.from(normalized, 'base64');
    if (raw.length < 1 + 12 + 2 + 4 + 16) return null;

    let offset = 0;
    const ivLength = raw.readUInt8(offset);
    offset += 1;
    if (ivLength <= 0 || offset + ivLength + 2 > raw.length) return null;

    const iv = raw.subarray(offset, offset + ivLength);
    offset += ivLength;

    const aadLength = raw.readUInt16LE(offset);
    offset += 2;
    if (offset + aadLength + 4 > raw.length) return null;

    const aad = raw.subarray(offset, offset + aadLength);
    offset += aadLength;

    const cipherLength = raw.readUInt32LE(offset);
    offset += 4;
    if (offset + cipherLength + 16 > raw.length) return null;

    const cipherText = raw.subarray(offset, offset + cipherLength);
    offset += cipherLength;

    const tag = raw.subarray(offset);
    if (tag.length < 16) return null;

    const key = crypto.createHash('sha256').update(clientSecret, 'utf8').digest();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    if (aad.length > 0) {
      decipher.setAAD(aad);
    }
    decipher.setAuthTag(tag);

    const decrypted = Buffer.concat([decipher.update(cipherText), decipher.final()]).toString('utf8');
    return JSON.parse(decrypted);
  } catch {
    return null;
  }
}

export function mintWsRegistrationToken({ meetingUUID, userID = '', secret, ttlMs = DEFAULT_TOKEN_TTL_MS, now = Date.now() }) {
  if (!secret || !meetingUUID) return '';
  const payload = {
    meetingUUID: String(meetingUUID),
    userID: userID ? String(userID) : '',
    exp: now + ttlMs
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = crypto
    .createHmac('sha256', secret)
    .update(encodedPayload)
    .digest('base64url');
  return `${encodedPayload}.${signature}`;
}

export function verifyWsRegistrationToken(token, { expectedMeetingUUID, secret, now = Date.now() } = {}) {
  if (!token || typeof token !== 'string' || !secret) return { valid: false };
  const parts = token.split('.');
  if (parts.length !== 2) return { valid: false };

  const [encodedPayload, providedSig] = parts;
  const expectedSig = crypto
    .createHmac('sha256', secret)
    .update(encodedPayload)
    .digest('base64url');

  if (!timingSafeEqualString(providedSig, expectedSig)) {
    return { valid: false };
  }

  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
    if (!payload || typeof payload.exp !== 'number' || payload.exp <= now) {
      return { valid: false };
    }
    if (expectedMeetingUUID && payload.meetingUUID && String(payload.meetingUUID) !== String(expectedMeetingUUID)) {
      return { valid: false };
    }
    return { valid: true, payload };
  } catch {
    return { valid: false };
  }
}

export function mintTokenFromZoomAppHeader(headerValue, { clientSecret, signingSecret, ttlMs = DEFAULT_TOKEN_TTL_MS } = {}) {
  const ctx = decryptZoomAppContext(headerValue, clientSecret);
  if (!ctx) return '';
  const meetingUUID = ctx.mid || ctx.meetingUUID || ctx.meetingId || '';
  if (!meetingUUID) return '';
  const secret = signingSecret || clientSecret;
  return mintWsRegistrationToken({
    meetingUUID,
    userID: ctx.uid || '',
    secret,
    ttlMs
  });
}

export function createAuthorizeRegistration({
  getActiveConnections = () => [],
  authToken = '',
  signingSecret = '',
  allowPreRtms = false
} = {}) {
  return async ({ meetingUUID, userID, token }) => {
    if (!meetingUUID || userID == null || String(userID).trim() === '') {
      return { authorized: false };
    }

    const normalizedMeetingUUID = String(meetingUUID);
    const normalizedUserID = String(userID);

    const connections = getActiveConnections() || [];
    const hasActiveMeeting = connections.some((conn) =>
      String(conn.meetingUuid || conn.rtmsId || '') === normalizedMeetingUUID
    );
    if (hasActiveMeeting) {
      return { authorized: true, meetingUUID: normalizedMeetingUUID, userID: normalizedUserID };
    }

    if (authToken && timingSafeEqualString(String(token || ''), String(authToken))) {
      return { authorized: true, meetingUUID: normalizedMeetingUUID, userID: normalizedUserID };
    }

    if (signingSecret && token) {
      const verified = verifyWsRegistrationToken(String(token), {
        expectedMeetingUUID: normalizedMeetingUUID,
        secret: signingSecret
      });
      if (verified.valid) {
        return { authorized: true, meetingUUID: normalizedMeetingUUID, userID: normalizedUserID };
      }
    }

    if (allowPreRtms) {
      return { authorized: true, meetingUUID: normalizedMeetingUUID, userID: normalizedUserID };
    }

    return { authorized: false };
  };
}
