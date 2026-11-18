import crypto from 'node:crypto';
import { signWebhook, urlValidationResponse } from '../../shared/webhookSignature.js';

/**
 * Ask a live webhook endpoint the same question Zoom asks when you save an event
 * subscription: send endpoint.url_validation with a plainToken and expect the
 * HMAC of it back. Nothing else is sent. Pass fetchImpl in tests.
 */
export async function probeWebhookEndpoint({ url, secret, fetchImpl = fetch, timeoutMs = 8000 }) {
  if (!url) return { ok: false, reason: 'missing_url' };
  if (!secret) return { ok: false, reason: 'missing_secret_token' };
  const plainToken = crypto.randomBytes(12).toString('hex');
  const body = JSON.stringify({ event: 'endpoint.url_validation', payload: { plainToken }, event_ts: Date.now() });
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...signWebhook(body, secret) },
      body,
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (res.status !== 200) return { ok: false, reason: 'unexpected_status', status: res.status };
    const json = await res.json().catch(() => null);
    const expected = urlValidationResponse(plainToken, secret);
    if (!json) return { ok: false, reason: 'response_not_json', status: res.status };
    if (json.plainToken !== expected.plainToken) return { ok: false, reason: 'plain_token_not_echoed', status: res.status };
    if (json.encryptedToken !== expected.encryptedToken) return { ok: false, reason: 'encrypted_token_mismatch', status: res.status, hint: 'The endpoint is using a different secret token than the one you supplied.' };
    return { ok: true, reason: 'validated', status: res.status };
  } catch (error) {
    return { ok: false, reason: error.name === 'TimeoutError' ? 'timeout' : 'request_failed', detail: error.code || error.message };
  }
}
