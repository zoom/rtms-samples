import dotenv from 'dotenv';
import express from 'express';
import fs from 'fs';
import { RTMSManager } from 'rtms-manager';
import { MediaArtifactRecorder } from './mediaArtifactRecorder.js';
import { uploadArtifact } from '../shared/artifactClient.js';
import { buildEnvelope, getWebhookFromEnvelope } from '../shared/envelope.js';
import { fireAndForget, getJson, postJson } from '../shared/http.js';
import {
  RealtimeMetricsReporter,
  postRealtimeEvent,
  postRealtimeStreamState,
  postRealtimeSummary
} from '../shared/realtimeCacheClient.js';
import { isStartEvent, isStopEvent } from '../shared/regions.js';
import { createRtmsObservabilityLogger } from '../shared/rtmsObservabilityLogger.js';
import { readZoomCredentials } from '../shared/secretConfig.js';

dotenv.config();

const app = express();
const port = Number(process.env.COMPUTE_PORT || 4300);
const regionCode = process.env.SPOKE_REGION || 'IAD';
const nodeId = process.env.SPOKE_NODE_ID || `${regionCode.toLowerCase()}-${process.pid}`;
const regionalStoreUrl = process.env.REGIONAL_STORE_URL || process.env.CENTRAL_STORE_URL || 'http://127.0.0.1:4100';
const centralStoreUrl = process.env.CENTRAL_STORE_URL || regionalStoreUrl;
const artifactStorageUrl = process.env.ARTIFACT_STORAGE_URL || '';
const realtimeCacheUrl = process.env.REALTIME_CACHE_URL || '';
const startupStreamId = process.env.RTMS_STREAM_ID || null;
const startupEnvelopeRef = process.env.RTMS_ENVELOPE_REF || null;
const startupEnvelopeFile = process.env.RTMS_ENVELOPE_FILE || null;
const dryRun = process.env.DRY_RUN !== 'false';
const exitAfterStop = process.env.ONE_STREAM_PER_JOB === 'true' || (
  process.env.EXIT_AFTER_STOP !== 'false' && Boolean(startupStreamId || startupEnvelopeFile)
);
const leaseTtlMs = Number(process.env.LEASE_TTL_MS || 45000);
const leaseRenewIntervalMs = Number(process.env.LEASE_RENEW_INTERVAL_MS || 15000);
const localStreams = new Map();
const mediaRecorder = new MediaArtifactRecorder({
  enabled: process.env.MEDIA_RECORDING_ENABLED !== 'false',
  artifactStorageUrl,
  regionCode,
  nodeId,
  uploadTimeoutMs: Number(process.env.ARTIFACT_UPLOAD_TIMEOUT_MS || 30000),
  uploadAttempts: Number(process.env.ARTIFACT_UPLOAD_ATTEMPTS || 3),
  finalizeDelayMs: Number(process.env.MEDIA_FINALIZE_DELAY_MS || 2000)
});
const realtimeMetrics = new RealtimeMetricsReporter({
  url: realtimeCacheUrl,
  flushIntervalMs: Number(process.env.REALTIME_CACHE_FLUSH_INTERVAL_MS || 5000)
});
const rtmsLogger = createRtmsObservabilityLogger({
  service: 'regional-compute-job',
  regionCode,
  nodeId,
  level: process.env.RTMS_LOG_LEVEL || 'info',
  console: process.env.RTMS_LOG_CONSOLE !== 'false'
});
const { MEDIA_PARAMS } = RTMSManager;
const VALID_MEDIA_TYPE_FLAGS = new Set([1, 2, 3, 4, 5, 6, 8, 9, 10, 12, 16, 17, 18, 20, 24, 32]);

app.use(express.json({ limit: '10mb' }));

if (!dryRun) {
  await initializeRtmsManager();
}

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'regional-compute-job',
    regionCode,
    nodeId,
    regionalStoreUrl,
    centralStoreUrl,
    artifactStorageUrl: artifactStorageUrl || null,
    realtimeCacheUrl: realtimeCacheUrl || null,
    startupStreamId,
    startupEnvelopeRef,
    startupEnvelopeFile,
    dryRun,
    exitAfterStop,
    mediaRecordingEnabled: mediaRecorder.enabled,
    activeStreams: localStreams.size
  });
});

app.get('/local/streams', (_req, res) => {
  res.json({ streams: Array.from(localStreams.values()) });
});

app.post('/compute/webhook', (req, res) => {
  const envelope = req.body || {};
  res.sendStatus(202);
  fireAndForget(handleEnvelope(envelope), `spoke ${envelope.event || 'event'}`);
});

setInterval(() => {
  for (const stream of localStreams.values()) {
    fireAndForget(renewLease(stream), `renew ${stream.streamId}`);
  }
}, leaseRenewIntervalMs).unref();

async function handleEnvelope(envelope) {
  if (!envelope.streamId || !envelope.event) {
    console.warn('[regional-compute-job] ignoring malformed envelope');
    return;
  }

  if (isStartEvent(envelope.event)) {
    await handleStart(envelope);
    return;
  }

  if (isStopEvent(envelope.event)) {
    await handleStop(envelope);
    return;
  }

  await writeRegionalEvent(envelope.streamId, {
    type: 'spoke_ignored',
    event: envelope.event,
    envelope
  });
}

async function handleStart(envelope) {
  const webhook = getWebhookFromEnvelope(envelope);

  if (localStreams.has(envelope.streamId)) {
    await writeRegionalEvent(envelope.streamId, { type: 'duplicate_local_start', envelope });
    return;
  }

  const claim = await postJson(`${regionalStoreUrl}/streams/${encodeURIComponent(envelope.streamId)}/claim`, {
    nodeId,
    regionCode,
    ttlMs: leaseTtlMs,
    envelope
  });

  if (!claim.claimed) {
    await writeRegionalEvent(envelope.streamId, { type: 'claim_lost', nodeId, regionCode, owner: claim.stream?.ownerNodeId });
    return;
  }

  const stream = {
    streamId: envelope.streamId,
    event: envelope.event,
    productType: envelope.productType,
    rtmsId: envelope.rtmsId,
    regionCode,
    nodeId,
    leaseVersion: claim.stream.leaseVersion,
    state: dryRun ? 'dry_run_connected' : 'connecting',
    startedAt: new Date().toISOString()
  };
  localStreams.set(envelope.streamId, stream);
  mediaRecorder.registerStream(envelope.streamId, {
    rtmsId: envelope.rtmsId,
    productType: envelope.productType,
    startedAt: stream.startedAt
  });

  await writeRegionalState(envelope.streamId, stream);
  fireAndForget(writeRealtimeState(envelope.streamId, {
    ...stream,
    routeRegionCode: envelope.regionCode || null
  }), 'realtime start state');

  if (claim.stream?.stopEnvelope) {
    await handleStop(claim.stream.stopEnvelope);
    return;
  }

  if (dryRun) {
    await writeRegionalDocument(envelope.streamId, 'dry-run-start.md', [
      `# RTMS Dry Run Start`,
      ``,
      `- stream: ${envelope.streamId}`,
      `- region: ${regionCode}`,
      `- node: ${nodeId}`,
      `- event: ${envelope.event}`
    ].join('\n'));
    fireAndForget(writeRealtimeEvent(envelope.streamId, {
      type: 'dry_run_start',
      regionCode,
      nodeId,
      at: new Date().toISOString()
    }), 'realtime dry-run event');
    return;
  }

  RTMSManager.handleEvent(webhook.event, webhook.payload);
}

async function handleStop(envelope) {
  const webhook = getWebhookFromEnvelope(envelope);
  const stream = localStreams.get(envelope.streamId);
  if (stream) {
    stream.state = 'stopping';
    stream.stoppingAt = new Date().toISOString();
    await writeRegionalState(envelope.streamId, stream);
    fireAndForget(writeRealtimeState(envelope.streamId, stream), 'realtime stopping state');
  }

  if (!dryRun) {
    RTMSManager.handleEvent(webhook.event, webhook.payload);
  }

  await realtimeMetrics.flush();
  const mediaArtifacts = dryRun ? [] : await finalizeMediaArtifacts(envelope, stream);
  await writeFinalManifest(envelope, stream, mediaArtifacts);

  localStreams.delete(envelope.streamId);
  await postJson(`${regionalStoreUrl}/streams/${encodeURIComponent(envelope.streamId)}/release`, {
    nodeId,
    state: 'stopped'
  });
  fireAndForget(writeRealtimeState(envelope.streamId, {
    ...(stream || {}),
    streamId: envelope.streamId,
    state: 'stopped',
    stoppedAt: new Date().toISOString()
  }), 'realtime stopped state');

  if (exitAfterStop) {
    fireAndForget(shutdown('RTMS_STOP'), 'shutdown after stop');
  }
}

async function renewLease(stream) {
  const renewal = await postJson(`${regionalStoreUrl}/streams/${encodeURIComponent(stream.streamId)}/lease-renew`, {
    nodeId,
    leaseVersion: stream.leaseVersion,
    ttlMs: leaseTtlMs
  }, { timeoutMs: 2000 });

  if (!renewal.renewed) {
    console.warn(`[regional-compute-job] lease lost for ${stream.streamId}; closing local RTMS connection`);
    localStreams.delete(stream.streamId);
    if (!dryRun) {
      await closeRtmsStream(stream.streamId);
    }
    return;
  }

  if (renewal.stream?.stopEnvelope || renewal.stream?.state === 'stop_requested') {
    const stopEnvelope = renewal.stream.stopEnvelope || renewal.stream.stopRequestedEnvelope;
    if (stopEnvelope) {
      await handleStop(stopEnvelope);
      return;
    }

    console.warn(`[regional-compute-job] stop requested for ${stream.streamId} but no stop envelope was stored`);
  }
}

async function loadAndHandleStartupStream(streamId) {
  const stream = await getJson(`${regionalStoreUrl}/streams/${encodeURIComponent(streamId)}`, {
    timeoutMs: 5000,
    retryPolicy: { maxAttempts: 5, maxDelayMs: 2000 }
  });
  const envelope = getStartEnvelopeFromStoredStream(stream);
  await handleStart(envelope);
}

async function loadAndHandleStartupEnvelopeFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw);
  const envelope = normalizeStartupEnvelope(parsed);
  await handleStart(envelope);
}

function normalizeStartupEnvelope(value) {
  if (value?.streamId && value?.event && value?.payload) {
    return value;
  }

  if (value?.event && value?.payload) {
    return buildEnvelope(value.event, value.payload, 'rtms-envelope-file', value);
  }

  throw new Error('RTMS_ENVELOPE_FILE must contain either an internal envelope or a Zoom webhook body with event and payload');
}

function getStartEnvelopeFromStoredStream(stream) {
  if (stream?.startEnvelope?.event && stream.startEnvelope?.payload) {
    return stream.startEnvelope;
  }

  if (stream?.webhook?.event && stream.webhook?.payload) {
    return buildEnvelope(stream.webhook.event, stream.webhook.payload, 'regional-store', stream.webhook);
  }

  throw new Error(`No start webhook envelope found in regional store for stream=${stream?.streamId || 'unknown'}`);
}

async function initializeRtmsManager() {
  await mediaRecorder.initialize();

  await RTMSManager.init({
    logging: {
      enabled: true,
      console: false,
      file: false,
      level: process.env.RTMS_LOG_LEVEL || 'info'
    },
    logger: rtmsLogger,
    mediaSocketConnectionMode: process.env.MEDIA_SOCKET_CONNECTION_MODE || 'split',
    mediaTypes: getMediaTypesFlagFromEnv(),
    credentials: readZoomCredentials(),
    mediaParams: buildMediaParams()
  });

  RTMSManager.on('transcript', (event) => {
    const markdown = `# Transcript\n\n${event.userName || 'Unknown'}: ${event.text || ''}\n`;
    fireAndForget(writeRegionalDocument(event.streamId, `${Date.now()}-transcript.md`, markdown, event), 'transcript write');
    fireAndForget(writeRealtimeSummary(event.streamId, {
      text: event.text || '',
      userName: event.userName || 'Unknown',
      productType: event.productType || 'unknown',
      updatedAt: new Date().toISOString()
    }), 'realtime transcript summary');
  });

  RTMSManager.on('chat', (event) => {
    const markdown = `# Chat\n\n${event.userName || 'Unknown'}: ${event.text || ''}\n`;
    fireAndForget(writeRegionalDocument(event.streamId, `${Date.now()}-chat.md`, markdown, event), 'chat write');
    fireAndForget(writeRealtimeEvent(event.streamId, {
      type: 'chat',
      userName: event.userName || 'Unknown',
      text: event.text || '',
      at: new Date().toISOString()
    }), 'realtime chat event');
  });

  for (const mediaType of ['audio', 'video', 'sharescreen']) {
    RTMSManager.on(mediaType, (event) => {
      if (mediaType === 'audio') mediaRecorder.recordAudio(event);
      if (mediaType === 'video') mediaRecorder.recordVideo(event);
      realtimeMetrics.recordMedia(event.streamId, mediaType, event);
      if (process.env.WRITE_MEDIA_PACKET_EVENTS === 'true') {
        fireAndForget(writeRegionalEvent(event.streamId, {
          type: mediaType,
          userId: event.userId,
          userName: event.userName,
          timestamp: event.timestamp,
          bytes: event.buffer?.length || 0
        }), `${mediaType} write`);
      }
    });
  }

  RTMSManager.on('error', (error) => {
    console.error('[regional-compute-job] RTMS error:', error.toString ? error.toString() : error);
    rtmsLogger.error('[regional-compute-job] RTMS error:', error.toString ? error.toString() : error);
  });

  RTMSManager.on('stream_state_changed', (event) => {
    if (!event?.streamId) return;
    realtimeMetrics.recordCounter(event.streamId, 'stream_state_changes_total', 1);
    fireAndForget(writeRealtimeEvent(event.streamId, {
      type: 'rtms_stream_state_changed',
      state: event.state,
      event,
      at: new Date().toISOString()
    }), 'realtime stream state event');
    fireAndForget(writeRegionalEvent(event.streamId, {
      type: 'rtms_stream_state_changed',
      event
    }), 'rtms stream state write');
  });

  RTMSManager.on('session_state_changed', (event) => {
    if (!event?.streamId) return;
    realtimeMetrics.recordCounter(event.streamId, 'session_state_changes_total', 1);
    fireAndForget(writeRealtimeEvent(event.streamId, {
      type: 'rtms_session_state_changed',
      state: event.state,
      event,
      at: new Date().toISOString()
    }), 'realtime session state event');
    fireAndForget(writeRegionalEvent(event.streamId, {
      type: 'rtms_session_state_changed',
      event
    }), 'rtms session state write');
  });
}

function normalizeMode(value, fallback) {
  return String(value || fallback).trim().toLowerCase();
}

function getMediaTypesFlagFromEnv() {
  const rawValue = String(process.env.MEDIA_TYPES_FLAG || '32').trim();
  const parsedValue = Number.parseInt(rawValue, 10);

  if (!Number.isInteger(parsedValue) || !VALID_MEDIA_TYPE_FLAGS.has(parsedValue)) {
    throw new Error(
      `[regional-compute-job] Unsupported MEDIA_TYPES_FLAG: ${rawValue}. Use a valid RTMS media bitmask such as 1 (audio), 2 (video), 3 (audio+video), 9 (audio+transcript), or 32 (all).`
    );
  }

  return parsedValue;
}

function getAudioDataOptFromEnv() {
  const audioMode = normalizeMode(process.env.AUDIO_STREAM_MODE, 'mixed');

  if (audioMode === 'mixed') {
    return MEDIA_PARAMS.MEDIA_DATA_OPTION_AUDIO_MIXED_STREAM;
  }

  if (['multi', 'multiple', 'individual'].includes(audioMode)) {
    return MEDIA_PARAMS.MEDIA_DATA_OPTION_AUDIO_MULTI_STREAMS;
  }

  throw new Error(`[regional-compute-job] Unsupported AUDIO_STREAM_MODE: ${process.env.AUDIO_STREAM_MODE}`);
}

function getVideoDataOptFromEnv() {
  const videoMode = normalizeMode(process.env.VIDEO_STREAM_MODE, 'active');

  if (['active', 'active_speaker', 'single_active', 'speaker', 'speaker_view', 'mixed_speaker'].includes(videoMode)) {
    return MEDIA_PARAMS.MEDIA_DATA_OPTION_VIDEO_SINGLE_ACTIVE_STREAM;
  }

  if (['individual', 'single_individual'].includes(videoMode)) {
    return MEDIA_PARAMS.MEDIA_DATA_OPTION_VIDEO_SINGLE_INDIVIDUAL_STREAM;
  }

  throw new Error(`[regional-compute-job] Unsupported VIDEO_STREAM_MODE: ${process.env.VIDEO_STREAM_MODE}`);
}

function buildMediaParams() {
  return {
    audio: {
      contentType: MEDIA_PARAMS.MEDIA_CONTENT_TYPE_RAW_AUDIO,
      sampleRate: MEDIA_PARAMS.AUDIO_SAMPLE_RATE_SR_16K,
      channel: MEDIA_PARAMS.AUDIO_CHANNEL_MONO,
      codec: MEDIA_PARAMS.MEDIA_PAYLOAD_TYPE_L16,
      dataOpt: getAudioDataOptFromEnv(),
      sendRate: 100
    },
    video: {
      contentType: MEDIA_PARAMS.MEDIA_CONTENT_TYPE_RAW_VIDEO,
      codec: MEDIA_PARAMS.MEDIA_PAYLOAD_TYPE_H264,
      dataOpt: getVideoDataOptFromEnv(),
      resolution: MEDIA_PARAMS.MEDIA_RESOLUTION_HD,
      fps: 25
    },
    deskshare: {
      contentType: MEDIA_PARAMS.MEDIA_CONTENT_TYPE_RAW_VIDEO,
      codec: MEDIA_PARAMS.MEDIA_PAYLOAD_TYPE_JPG,
      resolution: MEDIA_PARAMS.MEDIA_RESOLUTION_HD,
      fps: 1
    },
    chat: {
      contentType: MEDIA_PARAMS.MEDIA_CONTENT_TYPE_TEXT
    },
    transcript: {
      contentType: MEDIA_PARAMS.MEDIA_CONTENT_TYPE_TEXT,
      language: MEDIA_PARAMS.LANGUAGE_ID_ENGLISH
    }
  };
}

async function closeRtmsStream(streamId) {
  try {
    RTMSManager.requestStreamClose(streamId);
  } catch (error) {
    console.warn(`[regional-compute-job] RTMS stream close request failed for ${streamId}; stopping RTMSManager: ${error.message}`);
  }

  await RTMSManager.stop();
}

async function writeRegionalState(streamId, state) {
  await postJson(`${regionalStoreUrl}/streams/${encodeURIComponent(streamId)}/state`, state);
  await syncToCentralStore(streamId, 'state', state);
}

async function writeRegionalEvent(streamId, event) {
  await postJson(`${regionalStoreUrl}/streams/${encodeURIComponent(streamId)}/events`, event);
  await syncToCentralStore(streamId, 'events', event);
}

async function writeRegionalDocument(streamId, name, markdown, metadata = {}) {
  const document = {
    name,
    markdown,
    metadata
  };
  await postJson(`${regionalStoreUrl}/streams/${encodeURIComponent(streamId)}/documents`, document);
  await syncToCentralStore(streamId, 'documents', document);
}

async function finalizeMediaArtifacts(envelope, stream = null) {
  try {
    const stoppedAt = new Date().toISOString();
    const artifacts = await mediaRecorder.finalizeAndUpload(envelope.streamId, {
      rtmsId: envelope.rtmsId || stream?.rtmsId || envelope.streamId,
      productType: envelope.productType || stream?.productType || 'unknown',
      stoppedAt
    });

    for (const artifact of artifacts) {
      await writeRegionalBlob(envelope.streamId, toBlobRecord(artifact));
    }

    if (artifacts.length > 0) {
      fireAndForget(writeRealtimeEvent(envelope.streamId, {
        type: 'artifacts_uploaded',
        count: artifacts.length,
        artifacts: artifacts.map((artifact) => ({
          artifactId: artifact.artifactId,
          artifactType: artifact.artifactType,
          fileName: artifact.fileName,
          blobUri: artifact.blobUri,
          bytes: artifact.byteSize
        })),
        at: stoppedAt
      }), 'realtime artifact event');
    }

    return artifacts;
  } catch (error) {
    console.warn(`[regional-compute-job] media artifact finalize/upload failed stream=${envelope.streamId}: ${error.message}`);
    fireAndForget(writeRealtimeEvent(envelope.streamId, {
      type: 'artifact_upload_failed',
      reason: error.message,
      at: new Date().toISOString()
    }), 'realtime artifact failure');
    return [];
  }
}

async function writeFinalManifest(envelope, stream = null, artifacts = []) {
  if (!artifactStorageUrl) return;

  const stoppedAt = new Date().toISOString();
  const manifest = {
    version: 'rtms-artifact-manifest/v1',
    streamId: envelope.streamId,
    rtmsId: envelope.rtmsId || stream?.rtmsId || null,
    productType: envelope.productType || stream?.productType || 'unknown',
    regionCode,
    nodeId,
    leaseVersion: stream?.leaseVersion || null,
    startedAt: stream?.startedAt || null,
    stoppedAt,
    stopEvent: envelope.event,
    artifacts: artifacts.map((artifact) => ({
      artifactId: artifact.artifactId,
      artifactType: artifact.artifactType,
      fileName: artifact.fileName,
      contentType: artifact.contentType,
      bytes: artifact.byteSize,
      sha256: artifact.sha256,
      blobUri: artifact.blobUri,
      objectKey: artifact.objectKey
    }))
  };

  try {
    const upload = await uploadArtifact(artifactStorageUrl, {
      streamId: envelope.streamId,
      rtmsId: manifest.rtmsId,
      regionCode,
      productType: manifest.productType,
      artifactType: 'manifest',
      fileName: 'manifest.json',
      contentType: 'application/json',
      content: JSON.stringify(manifest, null, 2),
      metadata: {
        nodeId,
        leaseVersion: String(manifest.leaseVersion || ''),
        stoppedAt
      }
    }, {
      timeoutMs: Number(process.env.ARTIFACT_UPLOAD_TIMEOUT_MS || 5000),
      retryPolicy: {
        maxAttempts: Number(process.env.ARTIFACT_UPLOAD_ATTEMPTS || 2),
        baseDelayMs: 250,
        maxDelayMs: 1000
      }
    });

    await writeRegionalBlob(envelope.streamId, toBlobRecord(upload.artifact));
  } catch (error) {
    console.warn(`[regional-compute-job] final manifest upload failed stream=${envelope.streamId}: ${error.message}`);
  }
}

function toBlobRecord(artifact) {
  return {
    name: artifact.fileName,
    contentType: artifact.contentType,
    blobUri: artifact.blobUri,
    artifactId: artifact.artifactId,
    bytes: artifact.byteSize,
    metadata: {
      provider: artifact.provider,
      bucket: artifact.bucket || null,
      objectKey: artifact.objectKey,
      artifactType: artifact.artifactType,
      sha256: artifact.sha256,
      rtmsId: artifact.rtmsId,
      regionCode: artifact.regionCode,
      productType: artifact.productType,
      createdAt: artifact.createdAt
    }
  };
}

async function writeRegionalBlob(streamId, blob) {
  await postJson(`${regionalStoreUrl}/streams/${encodeURIComponent(streamId)}/blobs`, blob);
  await syncToCentralStore(streamId, 'blobs', blob);
}

async function writeRealtimeState(streamId, state) {
  await postRealtimeStreamState(realtimeCacheUrl, streamId, {
    ...state,
    regionCode,
    nodeId,
    updatedAt: new Date().toISOString()
  });
}

async function writeRealtimeEvent(streamId, event) {
  await postRealtimeEvent(realtimeCacheUrl, streamId, {
    ...event,
    regionCode: event.regionCode || regionCode,
    nodeId: event.nodeId || nodeId
  });
}

async function syncToCentralStore(streamId, resource, body) {
  if (!centralStoreUrl || centralStoreUrl === regionalStoreUrl) return;

  try {
    await postJson(`${centralStoreUrl}/streams/${encodeURIComponent(streamId)}/${resource}`, {
      ...body,
      sourceRegionCode: regionCode,
      syncedToCentralAt: new Date().toISOString()
    }, {
      timeoutMs: 3000,
      retryPolicy: { maxAttempts: 2, maxDelayMs: 1000 }
    });
  } catch (error) {
    console.warn(`[regional-compute-job] central sync failed stream=${streamId} resource=${resource}: ${error.message}`);
  }
}

const server = app.listen(port, () => {
  console.log(`[04-regional-compute-job] ${nodeId} listening on http://127.0.0.1:${port}/compute/webhook dryRun=${dryRun}`);
  if (startupEnvelopeFile) {
    fireAndForget(loadAndHandleStartupEnvelopeFile(startupEnvelopeFile), `startup envelope file ${startupEnvelopeFile}`);
    return;
  }

  if (startupStreamId) {
    fireAndForget(loadAndHandleStartupStream(startupStreamId), `startup stream ${startupStreamId}`);
  }
});

let shutdownStarted = false;

async function shutdown(signal) {
  if (shutdownStarted) return;
  shutdownStarted = true;

  console.log(`[regional-compute-job] received ${signal}; stopping RTMSManager`);

  try {
    if (!dryRun) {
      await RTMSManager.stop();
    }
  } catch (error) {
    console.warn(`[regional-compute-job] RTMSManager stop failed: ${error.message}`);
  }

  try {
    await realtimeMetrics.flush();
    realtimeMetrics.stop();
    await rtmsLogger.stop?.();
  } catch (error) {
    console.warn(`[regional-compute-job] telemetry flush failed: ${error.message}`);
  }

  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGTERM', () => {
  fireAndForget(shutdown('SIGTERM'), 'shutdown');
});

process.on('SIGINT', () => {
  fireAndForget(shutdown('SIGINT'), 'shutdown');
});
