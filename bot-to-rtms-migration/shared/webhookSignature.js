import crypto from 'node:crypto';
import { TIMING } from './codes.js';
import { normalizeStartedPayload } from './rtmsPayload.js';

/**
 * Zoom webhook verification: x-zm-signature = "v0=" + HMAC-SHA256(secret, "v0:{timestamp}:{rawBody}").
 * Verify against the RAW body bytes, never a re-serialised object.
 * Mirrors library/javascript/webhookManager/zoomWebhookSignature.js, without the Express coupling.
 */
export function verifyWebhook({ headers = {}, rawBody, secret, toleranceSeconds = TIMING.webhookToleranceSeconds, nowMs = Date.now() }) {
  const signature = headers['x-zm-signature'];
  const timestamp = headers['x-zm-request-timestamp'];
  if (!secret) return { ok: false, reason: 'missing_webhook_secret_token' };
  if (!signature) return { ok: false, reason: 'missing_x_zm_signature' };
  if (!timestamp) return { ok: false, reason: 'missing_x_zm_request_timestamp' };
  if (!Buffer.isBuffer(rawBody)) return { ok: false, reason: 'missing_raw_body' };

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'invalid_x_zm_request_timestamp' };
  const ageSeconds = Math.abs(Math.floor(nowMs / 1000) - ts);
  if (toleranceSeconds > 0 && ageSeconds > toleranceSeconds) {
    return { ok: false, reason: 'stale_x_zm_request_timestamp', ageSeconds };
  }

  const expected = signWebhook(rawBody, secret, ts)['x-zm-signature'];
  const a = Buffer.from(String(signature));
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: 'invalid_x_zm_signature' };
  }
  return { ok: true, reason: 'verified', ageSeconds };
}

/** Produce the same headers Zoom sends. Used by the demo senders and tests. */
export function signWebhook(rawBody, secret, timestampSeconds = Math.floor(Date.now() / 1000)) {
  const body = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody);
  const signature = `v0=${crypto.createHmac('sha256', secret).update(`v0:${timestampSeconds}:${body}`).digest('hex')}`;
  return { 'x-zm-request-timestamp': String(timestampSeconds), 'x-zm-signature': signature };
}

/** Answer Zoom's endpoint.url_validation challenge. */
export function urlValidationResponse(plainToken, secret) {
  if (!secret) throw new Error('missing_webhook_secret_token');
  return { plainToken, encryptedToken: crypto.createHmac('sha256', secret).update(plainToken).digest('hex') };
}

/** Signature sent in the RTMS signaling and media handshakes. */
export function rtmsHandshakeSignature(clientId, meetingOrSessionId, streamId, clientSecret) {
  return crypto.createHmac('sha256', clientSecret).update(`${clientId},${meetingOrSessionId},${streamId}`).digest('hex');
}

/**
 * Webhook-layer dedupe key from the playbook:
 *   event + account + meeting/session + rtms_stream_id + event_ts
 * A different x-zm-request-id with the same key is still the same logical event.
 */
export function webhookDedupeKey(body = {}) {
  const n = normalizeStartedPayload(body.event || '', body.payload || {});
  const eventTs = body.event_ts ?? n.eventTs ?? '';
  return [body.event || '', n.accountId || '', n.meetingId || '', n.streamId || '', eventTs].join('|');
}
