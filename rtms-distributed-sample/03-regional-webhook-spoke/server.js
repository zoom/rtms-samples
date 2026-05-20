import dotenv from 'dotenv';
import express from 'express';
import { fireAndForget, postJson, putJson } from '../shared/http.js';
import { verifyInternalSignedRequest } from '../shared/internalSignature.js';
import { isStartEvent, isStopEvent } from '../shared/regions.js';
import { captureRawBody } from '../shared/zoomSignature.js';

dotenv.config();

const app = express();
const port = Number(process.env.SPOKE_PORT || 4200);
const regionCode = process.env.SPOKE_REGION || 'IAD';
const regionalStoreUrl = process.env.REGIONAL_STORE_URL || process.env.CENTRAL_STORE_URL || 'http://127.0.0.1:4100';
const internalWebhookSecret = process.env.INTERNAL_WEBHOOK_SECRET || process.env.SPOKE_WEBHOOK_SECRET;
const internalTimestampToleranceSeconds = Number(process.env.INTERNAL_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS || 300);
const computeEndpoints = parseComputeEndpoints();
const localEvents = [];
let nextComputeIndex = 0;

app.use(express.json({ verify: captureRawBody, limit: '10mb' }));

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'regional-webhook-spoke',
    regionCode,
    internalSignatureVerification: 'required',
    internalTimestampToleranceSeconds,
    regionalStoreUrl,
    computeEndpoints
  });
});

app.get('/local/events', (_req, res) => {
  res.json({ events: localEvents.slice(-200) });
});

app.post('/spoke/webhook', (req, res) => {
  const envelope = req.body || {};
  const verification = verifyInternalSignedRequest(req, internalWebhookSecret, {
    toleranceSeconds: internalTimestampToleranceSeconds
  });

  if (!verification.ok) {
    const status = verification.reason === 'missing_internal_webhook_secret' ? 500 : 401;
    console.warn(`[03-regional-webhook-spoke] rejected internal webhook reason=${verification.reason}`);
    return res.status(status).json({ error: 'invalid_internal_webhook', reason: verification.reason });
  }

  if (!envelope.streamId || !envelope.event) {
    return res.status(400).json({ error: 'missing_event_or_stream_id' });
  }

  remember(envelope);
  res.sendStatus(202);
  fireAndForget(handleRegionalEnvelope(envelope), `regional dispatch ${envelope.streamId || 'unknown'}`);
});

async function handleRegionalEnvelope(envelope) {
  await persistRegionalEnvelope(envelope);
  await dispatchToCompute(envelope);
}

async function persistRegionalEnvelope(envelope) {
  if (!envelope.streamId || !envelope.event) return;

  if (isStartEvent(envelope.event)) {
    await putJson(`${regionalStoreUrl}/streams/${encodeURIComponent(envelope.streamId)}/route`, {
      regionCode,
      selectedRegionCode: envelope.regionCode || regionCode,
      productType: envelope.productType,
      rtmsId: envelope.rtmsId,
      envelope,
      webhook: envelope.webhook || { event: envelope.event, payload: envelope.payload }
    }, { timeoutMs: 3000 });
    return;
  }

  if (isStopEvent(envelope.event)) {
    await postJson(`${regionalStoreUrl}/streams/${encodeURIComponent(envelope.streamId)}/state`, {
      state: 'stop_requested',
      stopEnvelope: envelope
    }, { timeoutMs: 3000 });
  }
}

async function dispatchToCompute(envelope) {
  if (computeEndpoints.length === 0) {
    throw new Error('No compute endpoints configured');
  }

  const endpoint = computeEndpoints[nextComputeIndex % computeEndpoints.length];
  nextComputeIndex += 1;

  console.log(`[03-regional-webhook-spoke] stream=${envelope.streamId} -> ${endpoint}`);
  await postJson(endpoint, envelope, { timeoutMs: 3000 });
}

function remember(envelope) {
  localEvents.push({
    event: envelope.event,
    streamId: envelope.streamId,
    regionCode: envelope.regionCode,
    receivedAt: new Date().toISOString()
  });

  if (localEvents.length > 1000) {
    localEvents.splice(0, localEvents.length - 1000);
  }
}

function parseComputeEndpoints() {
  if (!process.env.COMPUTE_ENDPOINTS) {
    return ['http://127.0.0.1:4300/compute/webhook'];
  }

  try {
    return JSON.parse(process.env.COMPUTE_ENDPOINTS);
  } catch (error) {
    throw new Error(`Invalid COMPUTE_ENDPOINTS JSON: ${error.message}`);
  }
}

app.listen(port, () => {
  console.log(`[03-regional-webhook-spoke] ${regionCode} listening on http://127.0.0.1:${port}/spoke/webhook`);
});
