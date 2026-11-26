const crypto = require('crypto');
const config = require('../config');

const CONTEXT_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

function deriveWsOrigins(req) {
  const origins = new Set();
  const candidates = [config.publicUrl, req?.headers?.host ? `http://${req.headers.host}` : ''];

  for (const raw of candidates) {
    if (!raw) continue;
    try {
      const parsed = new URL(raw);
      origins.add(`ws://${parsed.host}`);
      origins.add(`wss://${parsed.host}`);
    } catch {
      // Ignore malformed URLs
    }
  }

  return Array.from(origins);
}

/**
 * Security middleware for OWASP headers and CSP
 */
function securityHeaders(req, res, next) {
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  const wsOrigins = deriveWsOrigins(req).join(' ');
  const connectSrc = [
    "'self'",
    'ws:',
    'wss:',
    wsOrigins,
    'https://*.zoom.us',
    'wss://*.zoom.us'
  ]
    .filter(Boolean)
    .join(' ');

  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://appssdk.zoom.us; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src 'self' https://fonts.gstatic.com; " +
    `connect-src ${connectSrc}; ` +
    "img-src 'self' data: https:; " +
    "frame-ancestors 'self' https://*.zoom.us;"
  );

  res.setHeader('X-Frame-Options', 'ALLOW-FROM https://applications.zoom.us');
  res.setHeader('X-XSS-Protection', '1; mode=block');

  next();
}

/**
 * Decrypt and verify Zoom Apps `x-zoom-app-context` header (AES-256-GCM).
 * Format: [1B ivLen][iv][2B LE aadLen][aad][4B LE cipherLen][cipherText][16B authTag]
 */
function decryptZoomAppContext(contextHeader, clientSecret = config.zoomAppClientSecret) {
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

function getSigningSecret(secretOverride) {
  return secretOverride || config.sessionSecret || config.zoomAppClientSecret || '';
}

function mintContextToken(zoomContext, secretOverride) {
  const secret = getSigningSecret(secretOverride);
  if (!secret || !zoomContext) {
    return null;
  }

  const payload = {
    mid: zoomContext.mid || zoomContext.meetingUUID || null,
    uid: zoomContext.uid || zoomContext.participantUUID || null,
    role: zoomContext.role || 'attendee',
    exp: Date.now() + CONTEXT_TOKEN_TTL_MS
  };

  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = crypto
    .createHmac('sha256', secret)
    .update(encoded)
    .digest('base64url');

  return `${encoded}.${signature}`;
}

function verifyContextToken(token, secretOverride) {
  const secret = getSigningSecret(secretOverride);
  if (!token || typeof token !== 'string' || !secret) {
    return null;
  }

  const parts = token.split('.');
  if (parts.length !== 2) {
    return null;
  }

  const [encoded, providedSig] = parts;
  const expectedSig = crypto
    .createHmac('sha256', secret)
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

function isHostRole(role) {
  const normalized = String(role || '').trim().toLowerCase();
  return normalized === 'host' || normalized === 'cohost' || normalized === 'co-host';
}

function resolveZoomContextFromSources({ contextHeader, authToken, session, clientSecret, signingSecret } = {}) {
  const fromHeader = decryptZoomAppContext(contextHeader, clientSecret);
  if (fromHeader) {
    return { context: fromHeader, source: 'x-zoom-app-context' };
  }

  const fromToken = verifyContextToken(authToken, signingSecret);
  if (fromToken) {
    return { context: fromToken, source: 'x-zoom-app-token' };
  }

  if (session?.zoomContext) {
    return { context: session.zoomContext, source: 'session' };
  }

  return null;
}

/**
 * Middleware: extract verified Zoom App context (if present) and cache in session.
 */
function extractZoomContext(req, _res, next) {
  const resolved = resolveZoomContextFromSources({
    contextHeader: req.headers['x-zoom-app-context'],
    authToken: req.headers['x-zoom-app-token'],
    session: req.session
  });

  if (resolved) {
    req.zoomContext = resolved.context;
    req.zoomContextSource = resolved.source;
    if (req.session && resolved.source === 'x-zoom-app-context') {
      req.session.zoomContext = resolved.context;
    }
  }

  next();
}

/**
 * Middleware: require host or co-host role verified from x-zoom-app-context / session token.
 */
function requireHostRole(req, res, next) {
  if (!req.zoomContext) {
    const resolved = resolveZoomContextFromSources({
      contextHeader: req.headers['x-zoom-app-context'],
      authToken: req.headers['x-zoom-app-token'],
      session: req.session
    });
    if (resolved) {
      req.zoomContext = resolved.context;
      req.zoomContextSource = resolved.source;
    }
  }

  if (!req.zoomContext) {
    if (config.allowUnverifiedDevAuth) {
      return next();
    }
    return res.status(401).json({
      error: 'Missing or invalid Zoom App context (x-zoom-app-context)'
    });
  }

  if (!isHostRole(req.zoomContext.role)) {
    return res.status(403).json({
      error: 'Host or co-host role required for this action'
    });
  }

  const targetMeetingId = req.body?.meetingId || req.query?.meetingId || req.params?.meetingId;
  if (targetMeetingId && req.zoomContext.mid && String(req.zoomContext.mid) !== String(targetMeetingId)) {
    return res.status(403).json({
      error: 'Meeting context mismatch'
    });
  }

  return next();
}

/**
 * Verify a Socket.IO `join_meeting` request against verified Zoom App context or token.
 */
function verifySocketJoin({ meetingId, contextHeader, authToken, session, clientSecret, signingSecret } = {}) {
  if (!meetingId || typeof meetingId !== 'string') {
    return { authorized: false, reason: 'missing_meeting_id' };
  }

  const resolved = resolveZoomContextFromSources({
    contextHeader,
    authToken,
    session,
    clientSecret,
    signingSecret
  });

  if (!resolved) {
    if (config.allowUnverifiedDevAuth) {
      return { authorized: true, context: null, devBypass: true };
    }
    return { authorized: false, reason: 'missing_or_invalid_zoom_context' };
  }

  if (resolved.context.mid && String(resolved.context.mid) !== String(meetingId)) {
    return { authorized: false, reason: 'meeting_id_mismatch' };
  }

  return { authorized: true, context: resolved.context, source: resolved.source };
}

/**
 * Middleware: authenticate internal service-to-service calls using INTERNAL_WEBHOOK_TOKEN.
 */
function requireInternalToken(req, res, next) {
  const expectedToken = process.env.INTERNAL_WEBHOOK_TOKEN || config.internalWebhookToken;
  const receivedToken = req.headers.authorization?.replace(/^Bearer\s+/i, '');

  if (!expectedToken) {
    return res.status(500).json({ error: 'INTERNAL_WEBHOOK_TOKEN not configured' });
  }
  if (!receivedToken) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const expectedBuf = Buffer.from(expectedToken);
  const receivedBuf = Buffer.from(receivedToken);
  if (expectedBuf.length !== receivedBuf.length || !crypto.timingSafeEqual(expectedBuf, receivedBuf)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  return next();
}

/**
 * Validate Zoom webhook signature (handled in routes/webhooks.js)
 */
function validateZoomWebhook(req, res, next) {
  next();
}

module.exports = {
  securityHeaders,
  validateZoomWebhook,
  decryptZoomAppContext,
  mintContextToken,
  verifyContextToken,
  isHostRole,
  extractZoomContext,
  requireHostRole,
  requireInternalToken,
  verifySocketJoin
};
