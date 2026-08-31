import crypto from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

export function verifyZoomWebhook(
  headers: IncomingHttpHeaders,
  rawBody: Buffer | undefined,
  secretToken: string,
  toleranceSeconds: number,
  nowSeconds = Math.floor(Date.now() / 1000)
): boolean {
  const signature = headers['x-zm-signature'];
  const timestamp = headers['x-zm-request-timestamp'];
  if (typeof signature !== 'string' || typeof timestamp !== 'string' || !rawBody) return false;
  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds) || (toleranceSeconds > 0 && Math.abs(nowSeconds - timestampSeconds) > toleranceSeconds)) return false;
  const expected = `v0=${crypto.createHmac('sha256', secretToken).update(`v0:${timestamp}:${rawBody.toString('utf8')}`).digest('hex')}`;
  const receivedBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  return receivedBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(receivedBuffer, expectedBuffer);
}

export function safeErrorCode(error: unknown): string {
  if (error && typeof error === 'object') {
    const candidate = error as { code?: unknown; status?: unknown; name?: unknown };
    return String(candidate.code || candidate.status || candidate.name || 'operation_failed').slice(0, 80);
  }
  return 'operation_failed';
}

export function isWebhookTenantAuthorized(
  event: string,
  payload: Record<string, unknown>,
  expectedAccountId: string,
  knownStream: boolean
): boolean {
  if (typeof payload.account_id === 'string') return payload.account_id === expectedAccountId;
  // RTMS stopped payloads omit account_id, so bind them to an authenticated start event.
  return event === 'meeting.rtms_stopped' && knownStream;
}
