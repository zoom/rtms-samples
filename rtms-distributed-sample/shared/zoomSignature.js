import crypto from 'crypto';

export const DEFAULT_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS = 300;

export function captureRawBody(req, _res, buffer) {
  req.rawBody = buffer;
}

export function buildUrlValidationResponse(plainToken, secretToken) {
  if (!secretToken) {
    throw new Error('missing_webhook_secret_token');
  }

  const encryptedToken = crypto
    .createHmac('sha256', secretToken)
    .update(plainToken)
    .digest('hex');

  return { plainToken, encryptedToken };
}

export function verifyZoomWebhookSignature(req, secretToken, options = {}) {
  return verifyZoomWebhookRequest(req, secretToken, options).ok;
}

export function verifyZoomWebhookRequest(req, secretToken, options = {}) {
  const signature = req.headers['x-zm-signature'];
  const timestamp = req.headers['x-zm-request-timestamp'];
  const rawBody = getRawBodyText(req);
  const toleranceSeconds = Number(
    options.toleranceSeconds ?? DEFAULT_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS
  );

  if (!secretToken) return { ok: false, reason: 'missing_webhook_secret_token' };
  if (!signature) return { ok: false, reason: 'missing_x_zm_signature' };
  if (!timestamp) return { ok: false, reason: 'missing_x_zm_request_timestamp' };
  if (!rawBody) return { ok: false, reason: 'missing_raw_body' };

  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds)) {
    return { ok: false, reason: 'invalid_x_zm_request_timestamp' };
  }

  const nowMs = Date.now();
  const timestampMs = timestampSeconds * 1000;
  const ageSeconds = Math.abs(Math.floor(nowMs / 1000) - timestampSeconds);

  if (toleranceSeconds > 0) {
    if (ageSeconds > toleranceSeconds) {
      return {
        ok: false,
        reason: 'stale_x_zm_request_timestamp',
        ageSeconds,
        timestampSeconds,
        timestampMs,
        receivedAtMs: nowMs
      };
    }
  }

  const expected = buildZoomWebhookSignature(rawBody, secretToken, timestamp);

  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) {
    return { ok: false, reason: 'invalid_x_zm_signature' };
  }

  return {
    ok: true,
    reason: 'verified',
    timestampSeconds,
    timestampMs,
    receivedAtMs: nowMs,
    ageSeconds
  };
}

export function buildZoomWebhookSignature(rawBody, secretToken, timestamp) {
  const message = `v0:${timestamp}:${rawBody}`;
  return `v0=${crypto.createHmac('sha256', secretToken).update(message).digest('hex')}`;
}

function getRawBodyText(req) {
  if (req.rawBody) return req.rawBody.toString('utf8');
  if (typeof req.body === 'string') return req.body;
  if (req.body) return JSON.stringify(req.body);
  return '';
}
