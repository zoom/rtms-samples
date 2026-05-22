import dotenv from 'dotenv';
import express from 'express';
import { fireAndForget, postJson } from '../shared/http.js';
import {
  getSpokeGroupForRtmsCode,
  isInterruptedEvent,
  isStartEvent,
  isStopEvent,
  parseSpokeEndpoints,
  parseSpokeGroupMapping
} from '../shared/regions.js';
import { SqliteRoutingStore } from '../shared/sqliteRoutingStore.js';
import { createRtmsObservabilityLogger } from '../shared/rtmsObservabilityLogger.js';

dotenv.config();

const app = express();
const port = Number(process.env.CENTRAL_ROUTE_DISPATCHER_PORT || 4050);
const sqliteDbPath = process.env.ROUTER_SQLITE_DB_PATH || process.env.SQLITE_DB_PATH || '.data/router.sqlite';
const routingStore = new SqliteRoutingStore(sqliteDbPath);
const spokeEndpoints = parseRegionalSpokeEndpoints();
const spokeGroupByCode = parseSpokeGroupMapping();
const internalWebhookSecret = process.env.INTERNAL_WEBHOOK_SECRET || process.env.SPOKE_WEBHOOK_SECRET;
const logger = createRtmsObservabilityLogger({
  service: 'central-route-dispatcher',
  regionCode: 'central',
  nodeId: process.env.NODE_ID || `dispatcher-${process.pid}`,
  level: process.env.SERVICE_LOG_LEVEL || process.env.RTMS_LOG_LEVEL || 'info',
  console: process.env.SERVICE_LOG_CONSOLE !== 'false'
});

app.use(express.json({ limit: '10mb' }));

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'central-route-dispatcher',
    sqlite: routingStore.health(),
    spokeRequestSigning: internalWebhookSecret ? 'enabled' : 'disabled',
    spokeGroupByCode,
    spokeEndpoints
  });
});

app.post('/orchestrate/webhook', (req, res) => {
  const envelope = req.body || {};
  res.sendStatus(202);
  fireAndForget(orchestrate(envelope), `orchestrate ${envelope.event || 'event'}`);
});

async function orchestrate(envelope) {
  if (!envelope.streamId || !envelope.event) {
    logger.warn('[02-central-route-dispatcher] ignoring malformed envelope');
    return;
  }

  if (isStartEvent(envelope.event)) {
    const existingRoute = routingStore.getStreamRoute(envelope.streamId);
    const spokeGroup = existingRoute?.spokeGroup || getSpokeGroupForRtmsCode(envelope.regionCode, spokeGroupByCode);
    routingStore.upsertStreamRoute(envelope.streamId, {
      regionCode: existingRoute?.regionCode || envelope.regionCode,
      spokeGroup,
      productType: existingRoute?.productType || envelope.productType,
      rtmsId: existingRoute?.rtmsId || envelope.rtmsId,
      envelope
    });
    routingStore.writeStreamState(envelope.streamId, {
      state: existingRoute ? 'recovery_start_routed' : 'routed',
      regionCode: existingRoute?.regionCode || envelope.regionCode || 'UNKNOWN',
      spokeGroup,
      routedAt: new Date().toISOString()
    });
    await forwardToSpoke(existingRoute?.spokeGroup || envelope.regionCode || 'UNKNOWN', envelope);
    return;
  }

  if (isStopEvent(envelope.event)) {
    await routeStop(envelope);
    return;
  }

  if (isInterruptedEvent(envelope.event)) {
    await routeRecovery(envelope);
    return;
  }

  routingStore.appendStreamEvent(envelope.streamId, {
    type: 'route_dispatcher_ignored',
    event: envelope.event,
    envelope
  });
}

async function routeStop(envelope) {
  let regionCode = null;
  const route = routingStore.getStreamRoute(envelope.streamId);
  if (route) {
    regionCode = route.spokeGroup || route.regionCode;
  } else {
    logger.warn(`[02-central-route-dispatcher] no route for stop ${envelope.streamId}; using UNKNOWN fallback`);
  }

  routingStore.writeStreamState(envelope.streamId, {
    state: 'stop_requested',
    stopEnvelope: envelope,
    stopRequestedAt: new Date().toISOString()
  });

  if (regionCode) {
    await forwardToSpoke(regionCode, envelope);
    return;
  }

  await forwardToSpoke('UNKNOWN', envelope);
}

async function routeRecovery(envelope) {
  const route = routingStore.getStreamRoute(envelope.streamId);
  const regionCode = route?.spokeGroup || route?.regionCode || null;
  if (!regionCode) {
    logger.warn(`[02-central-route-dispatcher] no route for recovery ${envelope.streamId}; using UNKNOWN fallback`);
  }

  routingStore.writeStreamState(envelope.streamId, {
    state: 'recovery_requested',
    recoveryEnvelope: envelope,
    recoveryRequestedAt: new Date().toISOString()
  });

  await forwardToSpoke(regionCode || 'UNKNOWN', envelope);
}

async function forwardToSpoke(regionCode, envelope) {
  const rawTarget = String(regionCode || 'UNKNOWN');
  const normalizedCode = rawTarget.toUpperCase();
  const directSpokeGroup = spokeEndpoints[rawTarget]
    ? rawTarget
    : Object.keys(spokeEndpoints).find((key) => key.toLowerCase() === rawTarget.toLowerCase());
  const spokeGroup = directSpokeGroup || getSpokeGroupForRtmsCode(normalizedCode, spokeGroupByCode);
  const endpoint = spokeEndpoints[directSpokeGroup] || spokeEndpoints[spokeGroup] || spokeEndpoints[normalizedCode] || spokeEndpoints.UNKNOWN;
  if (!endpoint) {
    throw new Error(`No regional spoke endpoint configured for code=${normalizedCode} spokeGroup=${spokeGroup}`);
  }

  logger.info(`[02-central-route-dispatcher] ${envelope.event} stream=${envelope.streamId} code=${normalizedCode} spokeGroup=${spokeGroup} -> ${endpoint}`);
  await postJson(endpoint, envelope, {
    timeoutMs: 3000,
    signingSecret: internalWebhookSecret
  });
}

function parseRegionalSpokeEndpoints() {
  if (process.env.REGIONAL_SPOKE_ENDPOINTS) {
    try {
      return JSON.parse(process.env.REGIONAL_SPOKE_ENDPOINTS);
    } catch (error) {
      throw new Error(`Invalid REGIONAL_SPOKE_ENDPOINTS JSON: ${error.message}`);
    }
  }

  return parseSpokeEndpoints(process.env);
}

app.listen(port, () => {
  logger.info(`[02-central-route-dispatcher] listening on http://127.0.0.1:${port}/orchestrate/webhook`);
});
