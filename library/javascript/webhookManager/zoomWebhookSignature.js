import crypto from 'crypto';

export const DEFAULT_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS = 300;

export function captureRawBody(req, _res, buffer) {
  req.rawBody = Buffer.from(buffer);
}

export function buildUrlValidationResponse(plainToken, secretToken) {
  if (!secretToken) throw new Error('missing_webhook_secret_token');
  const encryptedToken = crypto
    .createHmac('sha256', secretToken)
    .update(plainToken)
    .digest('hex');
  return { plainToken, encryptedToken };
}

export function verifyZoomWebhookRequest(req, secretToken, options = {}) {
  const signature = req.headers?.['x-zm-signature'];
  const timestamp = req.headers?.['x-zm-request-timestamp'];
  const configuredTolerance = Number(
    options.toleranceSeconds ?? DEFAULT_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS
  );
  const toleranceSeconds = Number.isFinite(configuredTolerance) && configuredTolerance >= 0
    ? configuredTolerance
    : DEFAULT_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS;

  if (!secretToken) return { ok: false, reason: 'missing_webhook_secret_token' };
  if (!signature) return { ok: false, reason: 'missing_x_zm_signature' };
  if (!timestamp) return { ok: false, reason: 'missing_x_zm_request_timestamp' };
  if (!Buffer.isBuffer(req.rawBody)) return { ok: false, reason: 'missing_raw_body' };

  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds)) {
    return { ok: false, reason: 'invalid_x_zm_request_timestamp' };
  }
  const ageSeconds = Math.abs(Math.floor(Date.now() / 1000) - timestampSeconds);
  if (toleranceSeconds > 0 && ageSeconds > toleranceSeconds) {
    return { ok: false, reason: 'stale_x_zm_request_timestamp', ageSeconds };
  }

  const message = `v0:${timestamp}:${req.rawBody.toString('utf8')}`;
  const expected = `v0=${crypto
    .createHmac('sha256', secretToken)
    .update(message)
    .digest('hex')}`;
  const receivedBuffer = Buffer.from(String(signature));
  const expectedBuffer = Buffer.from(expected);
  if (
    receivedBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(receivedBuffer, expectedBuffer)
  ) {
    return { ok: false, reason: 'invalid_x_zm_signature' };
  }

  return { ok: true, reason: 'verified', ageSeconds };
}
