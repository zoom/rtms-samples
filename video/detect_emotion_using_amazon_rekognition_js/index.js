import { RTMSManager } from '../../library/javascript/rtmsManager/RTMSManager.js';
import WebhookManager from '../../library/javascript/webhookManager/WebhookManager.js';
import detectEmotions from './amazonRekognition.js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import http from 'http';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '.env') });

const { MEDIA_PARAMS } = RTMSManager;

let frameCounter = 0;
const PROCESS_EVERY_N_FRAMES = parseInt(process.env.PROCESS_EVERY_N_FRAMES) || 50;

const appConfig = {
  port: process.env.PORT || 3000,
};

const rtmsConfig = {
  logging: {
    enabled: true,
    logDir: path.join(__dirname, 'logs'),
    console: true
  },
  mediaSocketConnectionMode: process.env.MEDIA_SOCKET_CONNECTION_MODE || 'unified',
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
      codec: MEDIA_PARAMS.MEDIA_PAYLOAD_TYPE_JPG,
      resolution: MEDIA_PARAMS.MEDIA_RESOLUTION_HD,
      fps: 25,
    }
  }
};

console.log('[detect_emotion] App Configuration:', appConfig);
console.log('[detect_emotion] RTMS Configuration:', RTMSManager.redactSecrets(rtmsConfig));
console.log(`[detect_emotion] Processing every ${PROCESS_EVERY_N_FRAMES} frames`);

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
  console.log('[detect_emotion] Webhook Event:', event);
  RTMSManager.handleEvent(event, payload);
});

webhookManager.setup();

RTMSManager.on('video', async (payload) => {
  const { buffer, userId, userName, timestamp } = payload;
  frameCounter++;

  if (frameCounter % PROCESS_EVERY_N_FRAMES === 0) {
    try {
      const emotions = await detectEmotions(buffer);
      if (emotions.length > 0) {
        console.log(`[detect_emotion] Frame ${frameCounter} - User: ${userName || userId}`);
        console.log(JSON.stringify(emotions, null, 2));
      }
    } catch (err) {
      console.error(`[detect_emotion] Error on frame ${frameCounter}:`, err.message);
    }
  }
});

RTMSManager.on('meeting.rtms_started', (payload) => {
  console.log('[detect_emotion] RTMS Started:', payload.meeting_uuid);
  frameCounter = 0;
});

RTMSManager.on('meeting.rtms_stopped', (payload) => {
  console.log('[detect_emotion] RTMS Stopped:', payload.meeting_uuid);
});

RTMSManager.on('error', (error) => {
  console.error('[detect_emotion] RTMSManager error:', error.message);
  if (error.code) console.error('[detect_emotion] Error code:', error.code);
});

await RTMSManager.start();

server.listen(appConfig.port, () => {
  console.log(`[detect_emotion] Server listening on port ${appConfig.port}`);
  console.log(`[detect_emotion] Webhook endpoint: http://localhost:${appConfig.port}${process.env.WEBHOOK_PATH || '/webhook'}`);
});

process.on('SIGINT', async () => {
  console.log('[detect_emotion] Shutting down...');
  server.close();
  await RTMSManager.stop();
  process.exit(0);
});
