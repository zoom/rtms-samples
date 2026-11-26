import crypto from 'crypto';

const DEFAULT_TOKEN_TTL_MS = 2 * 60 * 60 * 1000;

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

export function createRegistrationAuthorizer({
  getActiveConnections,
  staticAuthToken = '',
  signingSecret = '',
  allowPreRtmsRegistration = false
}) {
  return async ({ meetingUUID, userID, token } = {}) => {
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
