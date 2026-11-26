import crypto from 'crypto';

const DEFAULT_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Decrypt and verify Zoom Apps `x-zoom-app-context` header (AES-256-GCM).
 */
export function decryptZoomAppContext(contextHeader, clientSecret) {
  if (!contextHeader || typeof contextHeader !== 'string' || !clientSecret) {
    return null;
  }

  try {
    const buf = Buffer.from(contextHeader, 'base64');
    let offset = 0;

    if (buf.length < 1 + 2 + 4 + 16) {
      return null;
    }

    const ivLength = buf.readUInt8(offset);
    offset += 1;
    if (offset + ivLength + 2 > buf.length) return null;
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

    const tag = buf.subarray(offset, offset + 16);

    const key = crypto.createHash('sha256').update(clientSecret).digest();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    if (aadLength > 0) {
      decipher.setAAD(aad);
    }
    decipher.setAuthTag(tag);

    const decrypted = Buffer.concat([decipher.update(cipherText), decipher.final()]).toString('utf8');
    const parsed = JSON.parse(decrypted);

    if (parsed.exp && Number(parsed.exp) < Date.now()) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

export function mintFrontendWsToken(zoomContext, signingSecret, ttlMs = DEFAULT_TOKEN_TTL_MS) {
  if (!zoomContext || !signingSecret) {
    return '';
  }

  const payload = {
    mid: zoomContext.mid || zoomContext.meetingUUID || null,
    uid: zoomContext.uid || zoomContext.participantUUID || null,
    role: zoomContext.role || 'attendee',
    exp: Date.now() + ttlMs,
  };

  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = crypto
    .createHmac('sha256', signingSecret)
    .update(encoded)
    .digest('base64url');

  return `${encoded}.${signature}`;
}

export function verifyFrontendWsToken(token, signingSecret) {
  if (!token || typeof token !== 'string' || !signingSecret) {
    return null;
  }

  const parts = token.split('.');
  if (parts.length !== 2) {
    return null;
  }

  const [encoded, providedSig] = parts;
  const expectedSig = crypto
    .createHmac('sha256', signingSecret)
    .update(encoded)
    .digest('base64url');

  const providedBuf = Buffer.from(providedSig);
  const expectedBuf = Buffer.from(expectedSig);
  if (providedBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(providedBuf, expectedBuf)) {
    return null;
  }

  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (parsed.exp && Number(parsed.exp) < Date.now()) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function timingSafeTokenEqual(provided, expected) {
  if (!provided || !expected || typeof provided !== 'string' || typeof expected !== 'string') {
    return false;
  }
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Create a FrontendWssManager `authorizeRegistration` callback.
 * Authorizes if:
 * 1. `meetingUUID` matches an active RTMS connection, OR
 * 2. `token` matches optional `FRONTEND_WSS_AUTH_TOKEN` (timing-safe), OR
 * 3. `token` is a valid HMAC-signed token minted from verified `x-zoom-app-context`, OR
 * 4. `ALLOW_PRE_RTMS_REGISTRATION=true` is enabled for development.
 */
export function createAuthorizeRegistration({
  getActiveConnections,
  signingSecret,
  staticAuthToken = process.env.FRONTEND_WSS_AUTH_TOKEN || '',
  allowPreRtmsRegistration = process.env.ALLOW_PRE_RTMS_REGISTRATION === 'true',
} = {}) {
  return async ({ meetingUUID, userID, token }) => {
    const cleanMeeting = String(meetingUUID || '').trim();
    const cleanUser = String(userID || '').trim();
    if (!cleanMeeting || !cleanUser) {
      return { authorized: false };
    }

    // 1. Active RTMS connection match
    const connections = typeof getActiveConnections === 'function' ? getActiveConnections() : [];
    const hasActiveConnection = connections.some((conn) =>
      String(conn.meetingUuid || conn.rtmsId || '') === cleanMeeting
    );
    if (hasActiveConnection) {
      return { authorized: true, meetingUUID: cleanMeeting, userID: cleanUser };
    }

    // 2. Timing-safe static FRONTEND_WSS_AUTH_TOKEN match
    if (staticAuthToken && timingSafeTokenEqual(token, staticAuthToken)) {
      return { authorized: true, meetingUUID: cleanMeeting, userID: cleanUser };
    }

    // 3. Valid HMAC-signed token minted from verified x-zoom-app-context on GET /
    const verified = verifyFrontendWsToken(token, signingSecret);
    if (verified) {
      if (!verified.mid || String(verified.mid) === cleanMeeting) {
        return {
          authorized: true,
          meetingUUID: cleanMeeting,
          userID: cleanUser,
        };
      }
      return { authorized: false };
    }

    // 4. Opt-in dev pre-RTMS registration
    if (allowPreRtmsRegistration) {
      return { authorized: true, meetingUUID: cleanMeeting, userID: cleanUser };
    }

    return { authorized: false };
  };
}
