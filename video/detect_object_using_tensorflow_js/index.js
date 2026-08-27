import { RTMSManager } from '../../library/javascript/rtmsManager/RTMSManager.js';
import WebhookManager from '../../library/javascript/webhookManager/WebhookManager.js';
import { tensorFlowDetectObject } from './tensorFlowDetectObject.js';
import { H264FrameDecoder } from './ffmpegFrameDecoder.js';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import express from 'express';
import { closeHttpServer, installGracefulShutdown } from '../../library/javascript/commonHelpers/gracefulShutdown.js';
import http from 'http';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '.env') });

const { MEDIA_PARAMS } = RTMSManager;

const decoderMap = new Map();

function sanitizeFileName(name) {
  return name.replace(/[<>:"\/\\|?*=\s]/g, '_');
}

const appConfig = {
  port: process.env.PORT || 3000,
};

const rtmsConfig = {
  logging: {
    enabled: true,
    logDir: path.join(__dirname, 'logs'),
    console: true
  },
  mediaSocketConnectionMode: process.env.MEDIA_SOCKET_CONNECTION_MODE || 'split',
  mediaTypesFlag: 2,
  credentials: {
    meeting: {
      clientId: process.env.ZOOM_CLIENT_ID,
      clientSecret: process.env.ZOOM_CLIENT_SECRET,
      zoomSecretToken: process.env.ZOOM_SECRET_TOKEN,
    }
  },
  mediaParams: {
    video: {
      codec: MEDIA_PARAMS.MEDIA_PAYLOAD_TYPE_H264,
      resolution: MEDIA_PARAMS.MEDIA_RESOLUTION_HD,
      fps: 25,
    }
  }
};

console.log('[detect_object] App Configuration:', appConfig);
console.log('[detect_object] RTMS Configuration:', RTMSManager.redactSecrets(rtmsConfig));

const app = express();
const server = http.createServer(app);

await RTMSManager.init(rtmsConfig);

const webhookManager = new WebhookManager({
  config: {
    webhookPath: process.env.WEBHOOK_PATH || '/webhook',
    zoomSecretToken: rtmsConfig.credentials.meeting.zoomSecretToken,
  },
  app: app
});

webhookManager.on('event', (event, payload) => {
  console.log('[detect_object] Webhook Event:', event);
  RTMSManager.handleEvent(event, payload);
});

webhookManager.setup();

RTMSManager.on('video', (payload) => {
  const { buffer, userId, userName, timestamp, meetingId } = payload;

  const safeUserName = userName ? sanitizeFileName(userName) : 'default-view';
  const safeMeetingUuid = sanitizeFileName(meetingId);
  const outputDir = path.join(__dirname, 'recordings', safeMeetingUuid);
  fs.mkdirSync(outputDir, { recursive: true });

  if (!decoderMap.has(safeUserName)) {
    const decoder = new H264FrameDecoder(outputDir, (imagePath, metadata) => {
      const imgBuffer = fs.readFileSync(imagePath);
      tensorFlowDetectObject(imgBuffer, safeUserName, metadata.timestamp, safeMeetingUuid, false);
    });
    decoderMap.set(safeUserName, decoder);
  }

  decoderMap.get(safeUserName).writeChunk(buffer, { timestamp });
});

RTMSManager.on('meeting.rtms_started', (payload) => {
  console.log('[detect_object] RTMS Started:', payload.meeting_uuid);
});

RTMSManager.on('meeting.rtms_stopped', (payload) => {
  console.log('[detect_object] RTMS Stopped:', payload.meeting_uuid);
  for (const [key, decoder] of decoderMap.entries()) {
    decoder.close();
  }
  decoderMap.clear();
});

RTMSManager.on('error', (error) => {
  console.error('[detect_object] RTMSManager error:', error.message);
  if (error.code) console.error('[detect_object] Error code:', error.code);
});

await RTMSManager.start();

server.listen(appConfig.port, () => {
  console.log(`[detect_object] Server listening on port ${appConfig.port}`);
  console.log(`[detect_object] Webhook endpoint: http://localhost:${appConfig.port}${process.env.WEBHOOK_PATH || '/webhook'}`);
});

installGracefulShutdown({ name: 'detect_object', cleanup: async () => {
  for (const decoder of decoderMap.values()) {
    decoder.close();
  }
  decoderMap.clear();
  await closeHttpServer(server);
  await RTMSManager.stop();
} });
