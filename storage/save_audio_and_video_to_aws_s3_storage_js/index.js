import dotenv from 'dotenv';
import express from 'express';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VideoGapFiller } from '../../library/javascript/commonHelpers/HelperManager.js';
import { closeHttpServer, installGracefulShutdown } from '../../library/javascript/commonHelpers/gracefulShutdown.js';
import { RTMSManager } from '../../library/javascript/rtmsManager/RTMSManager.js';
import WebsocketManager from '../../library/javascript/webSocketManager/WebsocketManager.js';
import {
  buildUrlValidationResponse,
  captureRawBody,
  verifyZoomWebhookRequest
} from '../../library/javascript/webhookManager/zoomWebhookSignature.js';
import { DurableUploadQueue, enqueueStaleRecordings } from './DurableUploadQueue.js';
import { MediaRecorder } from './MediaRecorder.js';
import { createMediaProcessor } from './MediaProcessingPipeline.js';
import { createS3Storage } from './S3StorageHelper.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env'), quiet: true });

function numberConfig(name, fallback, { integer = false, minimum = 0 } = {}) {
  const configured = process.env[name];
  const value = configured === undefined || configured === '' ? fallback : Number(configured);
  if (!Number.isFinite(value) || value < minimum || (integer && !Number.isInteger(value))) {
    throw new Error(`${name} has an invalid value`);
  }
  return value;
}

function booleanConfig(name, fallback) {
  const configured = process.env[name];
  if (configured === undefined || configured === '') return fallback;
  if (configured === 'true') return true;
  if (configured === 'false') return false;
  throw new Error(`${name} must be true or false`);
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

const { MEDIA_PARAMS } = RTMSManager;
const recordingsDir = path.resolve(__dirname, process.env.RECORDINGS_DIR || 'recordings');
const appConfig = {
  port: numberConfig('PORT', 3000, { integer: true, minimum: 1 }),
  webhookPath: process.env.WEBHOOK_PATH || '/webhook',
  managerType: process.env.RTMSTRIGGERMANAGERTYPE || 'webhook',
  recordingsDir,
  recoveryStaleAfterMs: numberConfig('RECOVERY_STALE_AFTER_MINUTES', 10) * 60_000,
  recoveryScanIntervalMs: numberConfig('RECOVERY_SCAN_INTERVAL_MINUTES', 5) * 60_000,
  shutdownTimeoutMs: numberConfig('SHUTDOWN_TIMEOUT_MS', 30_000, { integer: true, minimum: 1 })
};
if (!['webhook', 'websocket'].includes(appConfig.managerType)) {
  throw new Error('RTMSTRIGGERMANAGERTYPE must be webhook or websocket');
}

const rtmsConfig = {
  logging: { enabled: false, console: false, file: false },
  mediaSocketConnectionMode: process.env.MEDIA_SOCKET_CONNECTION_MODE || 'split',
  mediaTypesFlag: numberConfig('MEDIA_TYPES_FLAG', 3, { integer: true, minimum: 1 }),
  credentials: {
    meeting: {
      clientId: process.env.ZOOM_CLIENT_ID,
      clientSecret: process.env.ZOOM_CLIENT_SECRET,
      zoomSecretToken: process.env.ZOOM_SECRET_TOKEN
    },
    video: {
      videoClientId: process.env.VIDEO_CLIENT_ID,
      videoClientSecret: process.env.VIDEO_CLIENT_SECRET,
      videoSecretToken: process.env.VIDEO_SECRET_TOKEN
    },
    s2s: {
      clientId: process.env.ZOOM_S2S_CLIENT_ID || null,
      clientSecret: process.env.ZOOM_S2S_CLIENT_SECRET || null,
      accountId: process.env.ZOOM_ACCOUNT_ID || null
    },
    websocket: {
      zoomWSURLForEvents: process.env.zoomWSURLForEvents || '',
      clientId: process.env.ZOOM_CLIENT_ID,
      clientSecret: process.env.ZOOM_CLIENT_SECRET
    }
  },
  mediaParams: {
    audio: {
      contentType: MEDIA_PARAMS.MEDIA_CONTENT_TYPE_RAW_AUDIO,
      sampleRate: MEDIA_PARAMS.AUDIO_SAMPLE_RATE_SR_16K,
      channel: MEDIA_PARAMS.AUDIO_CHANNEL_MONO,
      codec: MEDIA_PARAMS.MEDIA_PAYLOAD_TYPE_L16,
      dataOpt: MEDIA_PARAMS.MEDIA_DATA_OPTION_AUDIO_MIXED_STREAM,
      sendRate: 20
    },
    video: {
      contentType: MEDIA_PARAMS.MEDIA_CONTENT_TYPE_RAW_VIDEO,
      codec: MEDIA_PARAMS.MEDIA_PAYLOAD_TYPE_H264,
      dataOpt: MEDIA_PARAMS.MEDIA_DATA_OPTION_VIDEO_SINGLE_ACTIVE_STREAM,
      resolution: MEDIA_PARAMS.MEDIA_RESOLUTION_HD,
      fps: 25
    }
  }
};

console.log('[Archive] Starting RTMS S3 archiver', {
  port: appConfig.port,
  managerType: appConfig.managerType,
  mediaTypesFlag: rtmsConfig.mediaTypesFlag
});

await fs.mkdir(recordingsDir, { recursive: true });
const recorder = new MediaRecorder({ rootDir: recordingsDir });
const s3Storage = createS3Storage({ recordingsDir });
const mediaProcessor = createMediaProcessor({
  recordingsDir,
  uploadDirectory: s3Storage.uploadDirectory,
  fps: rtmsConfig.mediaParams.video.fps
});
const uploadQueue = new DurableUploadQueue({
  queueDir: path.join(recordingsDir, '.upload-queue'),
  recordingsDir,
  processor: mediaProcessor,
  concurrency: numberConfig('UPLOAD_QUEUE_CONCURRENCY', 1, { integer: true, minimum: 1 }),
  maxAttempts: numberConfig('UPLOAD_MAX_ATTEMPTS', 5, { integer: true, minimum: 1 }),
  retryBaseMs: numberConfig('UPLOAD_RETRY_BASE_SECONDS', 5) * 1000,
  retryMaxMs: numberConfig('UPLOAD_RETRY_MAX_SECONDS', 300) * 1000,
  deleteLocalAfterUpload: booleanConfig('DELETE_LOCAL_AFTER_UPLOAD', true),
  completedMediaRetentionMs: numberConfig('COMPLETED_MEDIA_RETENTION_HOURS', 24, { minimum: -1 }) * 60 * 60 * 1000,
  failedMediaRetentionMs: numberConfig('FAILED_MEDIA_RETENTION_DAYS', 7, { minimum: -1 }) * 24 * 60 * 60 * 1000,
  jobRetentionMs: numberConfig('QUEUE_RECORD_RETENTION_DAYS', 30, { minimum: -1 }) * 24 * 60 * 60 * 1000,
  cleanupIntervalMs: numberConfig('CLEANUP_INTERVAL_MINUTES', 60) * 60_000
});
await uploadQueue.start();

const recoverStaleMedia = async () => {
  const count = await enqueueStaleRecordings({
    recordingsDir,
    queue: uploadQueue,
    staleAfterMs: appConfig.recoveryStaleAfterMs,
    activeDirectories: recorder.getActiveDirectories()
  });
  if (count > 0) console.log(`[Archive] Recovered ${count} stale recording job(s)`);
};
await recoverStaleMedia();
const recoveryTimer = appConfig.recoveryScanIntervalMs > 0
  ? setInterval(() => recoverStaleMedia().catch((error) => {
      console.error('[Archive] Recovery scan failed:', error.message);
    }), appConfig.recoveryScanIntervalMs)
  : null;
recoveryTimer?.unref?.();

const app = express();
const server = http.createServer(app);
await RTMSManager.init(rtmsConfig);
let websocketManager = null;

if (appConfig.managerType === 'webhook') {
  app.use(appConfig.webhookPath, express.json({ verify: captureRawBody, limit: '1mb' }));
  app.post(appConfig.webhookPath, (req, res) => {
    const { event, payload } = req.body || {};
    const secretToken = req.query?.type === 'video'
      ? process.env.VIDEO_SECRET_TOKEN
      : process.env.ZOOM_SECRET_TOKEN;
    if (event === 'endpoint.url_validation' && payload?.plainToken) {
      if (!secretToken) return res.status(500).json({ error: 'webhook_secret_not_configured' });
      return res.json(buildUrlValidationResponse(payload.plainToken, secretToken));
    }
    const verification = verifyZoomWebhookRequest(req, secretToken, {
      toleranceSeconds: process.env.WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS
    });
    if (!verification.ok) {
      const status = verification.reason === 'missing_webhook_secret_token' ? 500 : 401;
      return res.status(status).json({ error: 'invalid_zoom_webhook' });
    }
    if (typeof event !== 'string' || !payload || typeof payload !== 'object') {
      return res.status(400).json({ error: 'invalid_webhook_payload' });
    }
    res.once('finish', () => setImmediate(() => RTMSManager.handleEvent(event, payload)));
    res.status(200).end();
  });
} else {
  const privateLogger = {
    log: (message) => console.log(message),
    warn: (message) => console.warn(message),
    error: (message) => console.error(message)
  };
  websocketManager = new WebsocketManager({
    config: rtmsConfig.credentials.websocket,
    logger: privateLogger
  });
  websocketManager.on('event', (event, payload) => RTMSManager.handleEvent(event, payload));
  await websocketManager.start();
}

const videoState = new Map();
RTMSManager.on('audio', (event) => {
  recorder.writeAudio(event).catch((error) => console.error('[Archive] Audio write failed:', error.message));
});

RTMSManager.on('video', (event) => {
  let state = videoState.get(event.streamId);
  if (!state) {
    const videoFiller = new VideoGapFiller({ fps: 25, gapThreshold: 320 });
    videoFiller.on('data', ({ buffer, timestamp }) => {
      recorder.writeVideo({ ...event, buffer, timestamp }).catch((error) => {
        console.error('[Archive] Video write failed:', error.message);
      });
    });
    videoFiller.start();
    state = { videoFiller };
    videoState.set(event.streamId, state);
  }
  state.videoFiller.push(event.buffer, event.timestamp);
});

RTMSManager.on('meeting.rtms_stopped', (payload) => {
  const streamId = payload.rtms_stream_id;
  const state = videoState.get(streamId);
  state?.videoFiller.stop();
  videoState.delete(streamId);

  void (async () => {
    const finalizedDirectory = await recorder.finalize(streamId);
    const relativeDirectory = finalizedDirectory || recorder.directoryFor(payload.meeting_uuid, streamId);
    if (await exists(path.join(recordingsDir, relativeDirectory))) {
      await uploadQueue.enqueue(relativeDirectory);
    }
  })().catch((error) => console.error('[Archive] Could not queue finalized recording:', error.message));
});

await RTMSManager.start();
server.listen(appConfig.port, () => {
  console.log(`[Archive] Server listening on port ${appConfig.port}`);
});

installGracefulShutdown({
  name: 'Archive',
  timeoutMs: appConfig.shutdownTimeoutMs,
  cleanup: async () => {
    if (recoveryTimer) clearInterval(recoveryTimer);
    websocketManager?.stop();
    for (const state of videoState.values()) state.videoFiller.stop();
    videoState.clear();
    await closeHttpServer(server);
    await RTMSManager.stop();
    const finalizedDirectories = (await recorder.stop()).filter(Boolean);
    await Promise.all(finalizedDirectories.map((relativeDirectory) => uploadQueue.enqueue(relativeDirectory)));
    await uploadQueue.stop();
  }
});
