import crypto from 'crypto';

export const INTERNAL_SIGNATURE_HEADER = 'x-rtms-signature';
export const INTERNAL_TIMESTAMP_HEADER = 'x-rtms-request-timestamp';
export const DEFAULT_INTERNAL_TIMESTAMP_TOLERANCE_SECONDS = 300;

export function buildInternalSignature(rawBody, secret, timestamp = Math.floor(Date.now() / 1000)) {
  const message = `v1:${timestamp}:${rawBody}`;
  return `v1=${crypto.createHmac('sha256', secret).update(message).digest('hex')}`;
}

export function buildInternalSignatureHeaders(rawBody, secret, timestamp = Math.floor(Date.now() / 1000)) {
  return {
    [INTERNAL_TIMESTAMP_HEADER]: String(timestamp),
    [INTERNAL_SIGNATURE_HEADER]: buildInternalSignature(rawBody, secret, timestamp)
  };
}

export function verifyInternalSignedRequest(req, secret, options = {}) {
  const signature = req.headers[INTERNAL_SIGNATURE_HEADER];
  const timestamp = req.headers[INTERNAL_TIMESTAMP_HEADER];
  const rawBody = getRawBodyText(req);
  const toleranceSeconds = Number(
    options.toleranceSeconds ?? DEFAULT_INTERNAL_TIMESTAMP_TOLERANCE_SECONDS
  );

  if (!secret) return { ok: false, reason: 'missing_internal_webhook_secret' };
  if (!signature) return { ok: false, reason: `missing_${INTERNAL_SIGNATURE_HEADER}` };
  if (!timestamp) return { ok: false, reason: `missing_${INTERNAL_TIMESTAMP_HEADER}` };
  if (!rawBody) return { ok: false, reason: 'missing_raw_body' };

  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds)) {
    return { ok: false, reason: `invalid_${INTERNAL_TIMESTAMP_HEADER}` };
  }

  if (toleranceSeconds > 0) {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const ageSeconds = Math.abs(nowSeconds - timestampSeconds);
    if (ageSeconds > toleranceSeconds) {
      return { ok: false, reason: `stale_${INTERNAL_TIMESTAMP_HEADER}`, ageSeconds };
    }
  }

  const expected = buildInternalSignature(rawBody, secret, timestamp);
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) {
    return { ok: false, reason: `invalid_${INTERNAL_SIGNATURE_HEADER}` };
  }

  return { ok: true, reason: 'verified' };
}

function getRawBodyText(req) {
  if (req.rawBody) return req.rawBody.toString('utf8');
  if (typeof req.body === 'string') return req.body;
  if (req.body) return JSON.stringify(req.body);
  return '';
}
