import crypto from 'crypto';

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest();
}

function timingSafeStringEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function decryptZoomAppContext(headerValue, clientSecret) {
  if (!headerValue || !clientSecret || typeof headerValue !== 'string') {
    return null;
  }

  try {
    const buf = Buffer.from(headerValue.trim(), 'base64');
    if (buf.length < 1 + 12 + 2 + 4 + 16) return null;

    let offset = 0;
    const ivLength = buf.readUInt8(offset);
    offset += 1;
    if (ivLength < 12 || offset + ivLength + 2 > buf.length) return null;
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
    if (tag.length !== 16) return null;

    const key = sha256(clientSecret);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);

    const decrypted = Buffer.concat([decipher.update(cipherText), decipher.final()]).toString('utf8');
    const parsed = JSON.parse(decrypted);
    if (!parsed || typeof parsed !== 'object') return null;

    if (parsed.exp && Number(parsed.exp) < Date.now()) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

export function mintWsAuthToken(context = {}, signingSecret, ttlMs = 60 * 60 * 1000) {
  if (!signingSecret) return '';
  const now = Date.now();
  const payload = {
    mid: context.mid || context.meetingUUID || null,
    uid: context.uid || context.userID || null,
    iat: now,
    exp: now + ttlMs
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = crypto
    .createHmac('sha256', String(signingSecret))
    .update(encodedPayload)
    .digest('base64url');
  return `${encodedPayload}.${signature}`;
}

export function verifyWsAuthToken(token, signingSecret, expectedMeetingUUID = null) {
  if (!token || !signingSecret || typeof token !== 'string') {
    return { valid: false };
  }

  const parts = token.split('.');
  if (parts.length !== 2) return { valid: false };
  const [encodedPayload, signature] = parts;

  const expectedSig = crypto
    .createHmac('sha256', String(signingSecret))
    .update(encodedPayload)
    .digest('base64url');

  if (!timingSafeStringEqual(signature, expectedSig)) {
    return { valid: false };
  }

  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
    if (!payload || typeof payload !== 'object') return { valid: false };
    if (!payload.exp || Number(payload.exp) < Date.now()) {
      return { valid: false };
    }
    if (payload.mid && expectedMeetingUUID && String(payload.mid) !== String(expectedMeetingUUID)) {
      return { valid: false };
    }
    return { valid: true, payload };
  } catch {
    return { valid: false };
  }
}

export function createZoomContextMiddleware({ clientSecret, signingSecret }) {
  const effectiveSigningSecret = signingSecret || clientSecret;
  return (req, res, next) => {
    res.locals.wsAuthToken = '';
    const header = req.headers['x-zoom-app-context'];
    if (header && clientSecret && effectiveSigningSecret) {
      const verified = decryptZoomAppContext(String(header), clientSecret);
      if (verified) {
        res.locals.zoomAppContext = verified;
        res.locals.wsAuthToken = mintWsAuthToken(verified, effectiveSigningSecret);
      }
    }
    next();
  };
}

export function createAuthorizeRegistration({
  getActiveConnections,
  signingSecret,
  env = process.env,
  onAuthorized = null
}) {
  return async ({ meetingUUID, userID, token, socket }) => {
    const normalizedMeeting = String(meetingUUID || '').trim();
    const normalizedUser = userID == null ? '' : String(userID).trim();
    if (!normalizedMeeting || !normalizedUser) {
      return { authorized: false };
    }

    const activeConnections = typeof getActiveConnections === 'function'
      ? getActiveConnections() || []
      : [];

    const hasActiveRtms = activeConnections.some((conn) =>
      String(conn?.meetingUuid || conn?.meetingUUID || conn?.rtmsId || '') === normalizedMeeting
    );

    const staticToken = String(env.FRONTEND_WSS_AUTH_TOKEN || '').trim();
    const hasStaticTokenMatch = Boolean(staticToken && token && timingSafeStringEqual(String(token), staticToken));

    const hmacCheck = token && signingSecret
      ? verifyWsAuthToken(String(token), signingSecret, normalizedMeeting)
      : { valid: false };

    const allowPreRtms = String(env.ALLOW_PRE_RTMS_REGISTRATION || '').toLowerCase() === 'true';

    if (hasActiveRtms || hasStaticTokenMatch || hmacCheck.valid || allowPreRtms) {
      if (typeof onAuthorized === 'function' && socket) {
        setImmediate(() => {
          if (socket.readyState === 1 && socket.meetingUUID) {
            onAuthorized({
              meetingUUID: normalizedMeeting,
              userID: normalizedUser,
              socket
            });
          }
        });
      }
      return {
        authorized: true,
        meetingUUID: normalizedMeeting,
        userID: normalizedUser
      };
    }

    return { authorized: false };
  };
}
