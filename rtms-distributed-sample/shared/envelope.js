import {
  extractRtmsRegionCode,
  getProductType,
  getRtmsId,
  getStreamId,
  isStartEvent,
  isStopEvent
} from './regions.js';
import { buildWebhookIdempotencyKey } from './idempotency.js';

export function buildEnvelope(event, payload = {}, source = 'unknown', webhookBody = null) {
  const productType = getProductType(event);
  const streamId = getStreamId(payload);
  const rtmsId = getRtmsId(payload, productType);
  const startEvent = isStartEvent(event);
  const stopEvent = isStopEvent(event);
  const regionCode = startEvent ? extractRtmsRegionCode(payload.server_urls) : null;
  const eventTs = payload.event_ts || null;

  return {
    schemaVersion: 1,
    source,
    event,
    eventType: startEvent ? 'start' : (stopEvent ? 'stop' : 'other'),
    productType,
    rtmsId,
    streamId,
    regionCode,
    idempotencyKey: buildWebhookIdempotencyKey({ event, payload, streamId, rtmsId, eventTs }),
    receivedAt: new Date().toISOString(),
    eventTs,
    webhook: webhookBody || { event, payload },
    payload
  };
}

export function getWebhookFromEnvelope(envelope = {}) {
  if (envelope.webhook?.event && envelope.webhook?.payload) {
    return envelope.webhook;
  }

  return {
    event: envelope.event,
    payload: envelope.payload || {}
  };
}
