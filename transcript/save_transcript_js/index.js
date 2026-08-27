import dotenv from 'dotenv';
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeHttpServer, installGracefulShutdown } from '../../library/javascript/commonHelpers/gracefulShutdown.js';
import { RTMSManager } from '../../library/javascript/rtmsManager/RTMSManager.js';
import {
  buildUrlValidationResponse,
  captureRawBody,
  verifyZoomWebhookRequest
} from '../../library/javascript/webhookManager/zoomWebhookSignature.js';
import { TranscriptStore } from './writeTranscriptToVtt.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env'), quiet: true });

function readNumber(name, fallback, { integer = false, minimum = 0 } = {}) {
  const configured = process.env[name];
  const value = configured === undefined || configured === '' ? fallback : Number(configured);
  if (!Number.isFinite(value) || value < minimum || (integer && !Number.isInteger(value))) {
    throw new Error(`${name} must be ${integer ? 'an integer' : 'a number'} greater than or equal to ${minimum}`);
  }
  return value;
}

const { MEDIA_PARAMS } = RTMSManager;
const appConfig = {
  port: readNumber('PORT', 3000, { integer: true, minimum: 1 }),
  webhookPath: process.env.WEBHOOK_PATH || '/webhook',
  outputDir: path.resolve(__dirname, process.env.TRANSCRIPT_OUTPUT_DIR || 'recordings'),
  retentionDays: readNumber('TRANSCRIPT_RETENTION_DAYS', 30),
  cleanupIntervalMs: readNumber('TRANSCRIPT_CLEANUP_INTERVAL_HOURS', 6) * 60 * 60 * 1000,
  dedupWindowEvents: readNumber('TRANSCRIPT_DEDUP_WINDOW_EVENTS', 10_000, { integer: true, minimum: 1 })
};

const rtmsConfig = {
  logging: {
    enabled: true,
    logDir: path.join(__dirname, 'logs'),
    console: true
  },
  mediaSocketConnectionMode: process.env.MEDIA_SOCKET_CONNECTION_MODE || 'split',
  mediaTypes: RTMSManager.MEDIA.TRANSCRIPT,
  credentials: {
    meeting: {
      clientId: process.env.ZOOM_CLIENT_ID,
      clientSecret: process.env.ZOOM_CLIENT_SECRET,
      zoomSecretToken: process.env.ZOOM_SECRET_TOKEN
    }
  },
  mediaParams: {
    transcript: {
      contentType: MEDIA_PARAMS.MEDIA_CONTENT_TYPE_TEXT,
      language: MEDIA_PARAMS.LANGUAGE_ID_ENGLISH
    }
  }
};

console.log('[save_transcript] App Configuration:', appConfig);
console.log('[save_transcript] RTMS Configuration:', RTMSManager.redactSecrets(rtmsConfig));

const transcriptStore = new TranscriptStore({
  rootDir: appConfig.outputDir,
  retentionDays: appConfig.retentionDays,
  cleanupIntervalMs: appConfig.cleanupIntervalMs,
  dedupWindowEvents: appConfig.dedupWindowEvents
});
await transcriptStore.start();

const app = express();
const server = http.createServer(app);
await RTMSManager.init(rtmsConfig);

app.use(appConfig.webhookPath, express.json({ verify: captureRawBody, limit: '1mb' }));
app.post(appConfig.webhookPath, (req, res) => {
  const { event, payload } = req.body || {};
  if (event === 'endpoint.url_validation' && payload?.plainToken) {
    if (!process.env.ZOOM_SECRET_TOKEN) {
      return res.status(500).json({ error: 'webhook_secret_not_configured' });
    }
    return res.json(buildUrlValidationResponse(payload.plainToken, process.env.ZOOM_SECRET_TOKEN));
  }

  const verification = verifyZoomWebhookRequest(req, process.env.ZOOM_SECRET_TOKEN, {
    toleranceSeconds: process.env.WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS
  });
  if (!verification.ok) {
    const status = verification.reason === 'missing_webhook_secret_token' ? 500 : 401;
    return res.status(status).json({ error: 'invalid_zoom_webhook' });
  }
  if (typeof event !== 'string' || !payload || typeof payload !== 'object') {
    return res.status(400).json({ error: 'invalid_webhook_payload' });
  }

  res.once('finish', () => {
    setImmediate(() => {
      try {
        console.log('[save_transcript] Verified webhook event:', event);
        RTMSManager.handleEvent(event, payload);
      } catch (error) {
        console.error('[save_transcript] Deferred webhook processing failed:', error.message);
      }
    });
  });
  res.status(200).end();
});

RTMSManager.on('transcript', async (event) => {
  console.log(`[TRANSCRIPT] ${event.userName || 'Unknown participant'}: ${event.text}`);
  try {
    const result = await transcriptStore.write(event);
    if (result.duplicate) console.log('[save_transcript] Ignored duplicate transcript event');
  } catch (error) {
    console.error('[save_transcript] Failed to persist transcript event:', error.message);
  }
});

RTMSManager.on('meeting.rtms_started', (payload) => {
  console.log('[save_transcript] RTMS Started:', payload.meeting_uuid);
});

RTMSManager.on('meeting.rtms_stopped', (payload) => {
  console.log('[save_transcript] RTMS Stopped:', payload.meeting_uuid);
  transcriptStore.closeStream(payload.rtms_stream_id).catch((error) => {
    console.error('[save_transcript] Failed to close transcript stream:', error.message);
  });
});

await RTMSManager.start();
server.listen(appConfig.port, () => {
  console.log(`[save_transcript] Server listening on port ${appConfig.port}`);
  console.log(`[save_transcript] Webhook endpoint: http://localhost:${appConfig.port}${appConfig.webhookPath}`);
});

installGracefulShutdown({ name: 'save_transcript', cleanup: async () => {
  await closeHttpServer(server);
  await RTMSManager.stop();
  await transcriptStore.stop();
} });
