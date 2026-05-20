import dotenv from 'dotenv';
import express from 'express';
import { buildEnvelope } from '../shared/envelope.js';
import { fireAndForget, postJson } from '../shared/http.js';
import { connectRabbitMq, createConfirmChannel, publishJson } from '../shared/rabbitmq.js';
import {
  buildUrlValidationResponse,
  captureRawBody,
  verifyZoomWebhookRequest
} from '../shared/zoomSignature.js';
import { isStartEvent, isStopEvent } from '../shared/regions.js';
import { SqliteRoutingStore } from '../shared/sqliteRoutingStore.js';
import { postRealtimeEvent, postWebhookObservation } from '../shared/realtimeCacheClient.js';
import { createRtmsObservabilityLogger } from '../shared/rtmsObservabilityLogger.js';

dotenv.config();

const app = express();
const port = Number(process.env.HUB_PORT || 4000);
const webhookPath = process.env.WEBHOOK_PATH || '/webhook';
const deliveryMode = process.env.HUB_DELIVERY_MODE || 'http';
const dispatcherUrl = process.env.CENTRAL_ROUTE_DISPATCHER_URL || 'http://127.0.0.1:4050/orchestrate/webhook';
const timestampToleranceSeconds = Number(process.env.WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS || 300);
const rabbitmqUrl = process.env.RABBITMQ_URL || 'amqp://rtms:rtms_password@127.0.0.1:5672/rtms';
const ingressExchange = process.env.RABBITMQ_INGRESS_EXCHANGE || 'rtms.ingress';
const ingressRoutingKey = process.env.RABBITMQ_INGRESS_ROUTING_KEY || 'webhook.received';
const idempotencyTtlMs = Number(process.env.WEBHOOK_IDEMPOTENCY_TTL_MS || 65 * 60 * 1000);
const idempotencySweepIntervalMs = Number(process.env.WEBHOOK_IDEMPOTENCY_SWEEP_INTERVAL_MS || 60 * 1000);
const sqliteDbPath = process.env.HUB_SQLITE_DB_PATH || process.env.SQLITE_DB_PATH || '.data/hub.sqlite';
const realtimeCacheUrl = process.env.REALTIME_CACHE_URL || '';
const routingStore = new SqliteRoutingStore(sqliteDbPath);
const logger = createRtmsObservabilityLogger({
  service: 'centralized-webhook-hub',
  regionCode: 'central',
  nodeId: process.env.NODE_ID || `hub-${process.pid}`,
  level: process.env.SERVICE_LOG_LEVEL || process.env.RTMS_LOG_LEVEL || 'info',
  console: process.env.SERVICE_LOG_CONSOLE !== 'false'
});
let rabbitChannel = null;

if (deliveryMode === 'rabbitmq') {
  const rabbitConnection = await connectRabbitMq(rabbitmqUrl, { label: 'webhook hub rabbitmq connect' });
  rabbitChannel = await createConfirmChannel(rabbitConnection);
}

app.use(express.json({ verify: captureRawBody, limit: '5mb' }));

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'centralized-webhook-hub',
    deliveryMode,
    webhookSignatureVerification: 'required',
    timestampToleranceSeconds,
    sqlite: routingStore.health(),
    idempotency: {
      ttlMs: idempotencyTtlMs,
      cleanupIntervalMs: idempotencySweepIntervalMs,
      acceptedKeyCount: routingStore.countWebhookIdempotency()
    },
    dispatcherUrl: deliveryMode === 'http' ? dispatcherUrl : undefined,
    rabbitmq: deliveryMode === 'rabbitmq'
      ? { exchange: ingressExchange, routingKey: ingressRoutingKey, ready: Boolean(rabbitChannel) }
      : undefined
  });
});

app.post(webhookPath, async (req, res) => {
  const { event, payload } = req.body || {};

  if (event === 'endpoint.url_validation' && payload?.plainToken) {
    const secretToken = req.query.type === 'video'
      ? process.env.VIDEO_SECRET_TOKEN
      : process.env.ZOOM_SECRET_TOKEN;
    try {
      return res.json(buildUrlValidationResponse(payload.plainToken, secretToken));
    } catch (error) {
      logger.error(`[01-centralized-webhook-hub] URL validation failed: ${error.message}`);
      return res.status(500).json({ error: 'webhook_secret_not_configured' });
    }
  }

  if (!event || !payload) {
    return res.status(400).json({ error: 'missing_event_or_payload' });
  }

  const verification = verifyZoomWebhookRequest(req, getSecretTokenForEvent(event), {
    toleranceSeconds: timestampToleranceSeconds
  });

  if (!verification.ok) {
    const status = verification.reason === 'missing_webhook_secret_token' ? 500 : 401;
    logger.warn(`[01-centralized-webhook-hub] rejected webhook event=${event} reason=${verification.reason}`);
    recordWebhookObservation('unverified', { event, reason: verification.reason });
    return res.status(status).json({ error: 'invalid_zoom_webhook', reason: verification.reason });
  }

  const envelope = buildEnvelope(event, payload, 'centralized-webhook-hub', req.body);
  const duplicate = isRtmsEvent(event) ? acceptWebhookIdempotency(envelope).duplicate : false;
  if (duplicate) {
    logger.info(`[01-centralized-webhook-hub] duplicate RTMS webhook dropped event=${event} stream=${envelope.streamId} key=${envelope.idempotencyKey}`);
    recordWebhookObservation('duplicate', { envelope });
    return res.set('x-rtms-duplicate', 'true').sendStatus(204);
  }

  recordWebhookObservation('accepted', { envelope });
  recordAcceptedWebhookLatency(envelope, verification);
  logger.info('[01-centralized-webhook-hub] accepted webhook', {
    event,
    eventType: envelope.eventType,
    streamId: envelope.streamId,
    regionCode: envelope.regionCode || 'UNKNOWN',
    deliveryMode
  });

  if (deliveryMode === 'rabbitmq') {
    if (!rabbitChannel) {
      routingStore.forgetWebhookIdempotency(envelope.idempotencyKey);
      return res.status(503).json({ error: 'webhook_queue_not_ready' });
    }

    try {
      await publishJson(rabbitChannel, ingressExchange, ingressRoutingKey, envelope, {
        label: `webhook ingress publish ${event}`,
        maxAttempts: 3,
        maxDelayMs: 1500
      });
      return res.sendStatus(204);
    } catch (error) {
      routingStore.forgetWebhookIdempotency(envelope.idempotencyKey);
      logger.error(`[01-centralized-webhook-hub] durable queue publish failed: ${error.message}`);
      return res.status(503).json({ error: 'webhook_queue_publish_failed' });
    }
  }

  res.sendStatus(204);
  fireAndForget(postJson(dispatcherUrl, envelope, { timeoutMs: 3000 }), `hub handoff ${event}`);
});

app.listen(port, () => {
  logger.info(`[01-centralized-webhook-hub] listening on http://127.0.0.1:${port}${webhookPath} deliveryMode=${deliveryMode}`);
});

function getSecretTokenForEvent(event = '') {
  if (event.startsWith('session.')) {
    return process.env.VIDEO_SECRET_TOKEN || process.env.ZOOM_SECRET_TOKEN;
  }

  return process.env.ZOOM_SECRET_TOKEN || process.env.VIDEO_SECRET_TOKEN;
}

function isRtmsEvent(event = '') {
  return isStartEvent(event) || isStopEvent(event);
}

function acceptWebhookIdempotency(envelope) {
  return routingStore.acceptWebhookIdempotency({
    idempotencyKey: envelope.idempotencyKey,
    event: envelope.event,
    streamId: envelope.streamId,
    rtmsId: envelope.rtmsId,
    ttlMs: idempotencyTtlMs
  });
}

function recordAcceptedWebhookLatency(envelope, verification) {
  if (!realtimeCacheUrl || !envelope.streamId || !isRtmsEvent(envelope.event)) return;

  const latencyMs = verification.timestampMs
    ? Math.max(0, Date.now() - Number(verification.timestampMs))
    : null;
  if (!Number.isFinite(latencyMs)) return;

  const common = {
    source: 'centralized-webhook-hub',
    regionCode: envelope.regionCode || 'UNKNOWN',
    nodeId: process.env.NODE_ID || `hub-${process.pid}`,
    at: envelope.receivedAt,
    labels: {
      event: envelope.event,
      eventType: envelope.eventType,
      productType: envelope.productType || 'unknown'
    }
  };

  fireAndForget(postRealtimeEvent(realtimeCacheUrl, envelope.streamId, {
    type: 'webhook_accepted',
    event: envelope.event,
    eventType: envelope.eventType,
    productType: envelope.productType || 'unknown',
    webhookIngressLatencyMs: latencyMs,
    regionCode: common.regionCode,
    nodeId: common.nodeId,
    at: envelope.receivedAt
  }), 'realtime webhook accepted event');
}

function recordWebhookObservation(category, details = {}) {
  if (!realtimeCacheUrl) return;
  const envelope = details.envelope || null;
  fireAndForget(postWebhookObservation(realtimeCacheUrl, {
    category,
    source: 'centralized-webhook-hub',
    nodeId: process.env.NODE_ID || `hub-${process.pid}`,
    event: envelope?.event || details.event || 'unknown',
    eventType: envelope?.eventType || details.eventType || '',
    reason: details.reason || '',
    regionCode: envelope?.regionCode || details.regionCode || 'UNKNOWN',
    streamId: envelope?.streamId || details.streamId || '',
    at: envelope?.receivedAt || details.at || new Date().toISOString()
  }), `webhook ${category} observation`);
}

setInterval(() => {
  const deleted = routingStore.cleanupExpiredWebhookIdempotency();
  if (deleted > 0) {
    logger.info(`[01-centralized-webhook-hub] expired ${deleted} RTMS idempotency key(s)`);
  }
}, idempotencySweepIntervalMs).unref();
