import crypto from 'node:crypto';

export function captureRawBody(req, _res, buffer) {
  req.rawBody = Buffer.from(buffer);
}

export function authenticateZoomWebhook(
  secretToken,
  configuredTolerance = Number(process.env.WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS || 300)
) {
  const toleranceSeconds = Number.isFinite(configuredTolerance) && configuredTolerance >= 0
    ? configuredTolerance
    : 300;
  return (req, res, next) => {
    if (req.body?.event === 'endpoint.url_validation') return next();
    if (!secretToken) {
      return res.status(500).json({ error: 'webhook_secret_not_configured' });
    }

    const signature = req.headers['x-zm-signature'];
    const timestamp = req.headers['x-zm-request-timestamp'];
    if (!signature || !timestamp || !Buffer.isBuffer(req.rawBody)) {
      return res.status(401).json({ error: 'invalid_zoom_webhook' });
    }

    const timestampSeconds = Number(timestamp);
    if (
      !Number.isFinite(timestampSeconds) ||
      (toleranceSeconds > 0 &&
        Math.abs(Math.floor(Date.now() / 1000) - timestampSeconds) > toleranceSeconds)
    ) {
      return res.status(401).json({ error: 'invalid_zoom_webhook' });
    }

    const expected = `v0=${crypto
      .createHmac('sha256', secretToken)
      .update(`v0:${timestamp}:${req.rawBody.toString('utf8')}`)
      .digest('hex')}`;
    const receivedBuffer = Buffer.from(String(signature));
    const expectedBuffer = Buffer.from(expected);
    if (
      receivedBuffer.length !== expectedBuffer.length ||
      !crypto.timingSafeEqual(receivedBuffer, expectedBuffer)
    ) {
      return res.status(401).json({ error: 'invalid_zoom_webhook' });
    }
    return next();
  };
}

const DEFAULT_ALLOWED_RTMS_HOST_SUFFIXES = Object.freeze(['zoom.us']);

export function normalizeWebhookPlainToken(plainToken) {
  if (typeof plainToken !== 'string') return null;
  if (plainToken.length < 8 || plainToken.length > 256) return null;
  if (!/^[\x21-\x7E]+$/.test(plainToken)) return null;
  return plainToken;
}

export function buildUrlValidationResponse(plainToken, secretToken) {
  if (!secretToken) throw new Error('missing_webhook_secret_token');
  const token = normalizeWebhookPlainToken(plainToken);
  if (!token) throw new Error('invalid_plain_token');
  const encryptedToken = crypto
    .createHmac('sha256', secretToken)
    .update(token)
    .digest('hex');
  return { plainToken: token, encryptedToken };
}

export function isAllowedRtmsCallbackUrl(value, allowedHosts) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return false;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'wss:' && parsed.protocol !== 'ws:') return false;
  const configured = allowedHosts
    ?? (typeof process !== 'undefined' && process.env?.RTMS_ALLOWED_MEDIA_HOSTS
      ? process.env.RTMS_ALLOWED_MEDIA_HOSTS.split(',')
      : DEFAULT_ALLOWED_RTMS_HOST_SUFFIXES);
  const suffixes = configured
    .map((host) => String(host).trim().toLowerCase().replace(/^\./, ''))
    .filter(Boolean);
  if (suffixes.length === 0) return true;
  const host = parsed.hostname.toLowerCase();
  return suffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

// RTMS protocol V2 can return several URLs for one endpoint, separated by
// commas (for example "wss://host/ws,srt://host:port"). WebSocket connections
// must use the ws/wss entry, so return the first allowed one.
export function selectAllowedRtmsCallbackUrl(value, allowedHosts) {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return value
    .split(',')
    .map((url) => url.trim())
    .find((url) => isAllowedRtmsCallbackUrl(url, allowedHosts));
}

// media_server.server_urls is usually an object keyed by media type
// (audio, video, deskshare, transcript, chat). V2 may instead return a single
// comma-separated string that serves every media type.
export function getRtmsMediaServerUrl(serverUrls, mediaType) {
  if (typeof serverUrls === 'string') return serverUrls;
  return serverUrls && typeof serverUrls === 'object' ? serverUrls[mediaType] : undefined;
}
