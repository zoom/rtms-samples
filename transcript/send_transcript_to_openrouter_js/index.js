import { RTMSManager } from '../../library/javascript/rtmsManager/RTMSManager.js';
import WebhookManager from '../../library/javascript/webhookManager/WebhookManager.js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import http from 'http';

import { contextualSynthesisFromMultipleModels } from './chatWithOpenrouter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '.env') });

const { MEDIA_PARAMS } = RTMSManager;

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
  mediaTypes: RTMSManager.MEDIA.TRANSCRIPT,
  credentials: {
    meeting: {
      clientId: process.env.ZOOM_CLIENT_ID,
      clientSecret: process.env.ZOOM_CLIENT_SECRET,
      zoomSecretToken: process.env.ZOOM_SECRET_TOKEN,
    }
  },
  mediaParams: {
    transcript: {
      contentType: MEDIA_PARAMS.MEDIA_CONTENT_TYPE_TEXT,
      language: MEDIA_PARAMS.LANGUAGE_ID_ENGLISH,
    }
  }
};

console.log('[send_to_openrouter] App Configuration:', appConfig);
console.log('[send_to_openrouter] RTMS Configuration:', RTMSManager.redactSecrets(rtmsConfig));

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
  console.log('[send_to_openrouter] Webhook Event:', event);
  RTMSManager.handleEvent(event, payload);
});

webhookManager.setup();

RTMSManager.on('transcript', async ({ text, userId, userName, timestamp, meetingId }) => {
  console.log(`[TRANSCRIPT] ${userName}: ${text}`);
  await contextualSynthesisFromMultipleModels(text);
});

RTMSManager.on('meeting.rtms_started', (payload) => {
  console.log('[send_to_openrouter] RTMS Started:', payload.meeting_uuid);
});

RTMSManager.on('meeting.rtms_stopped', (payload) => {
  console.log('[send_to_openrouter] RTMS Stopped:', payload.meeting_uuid);
});

await RTMSManager.start();

server.listen(appConfig.port, () => {
  console.log(`[send_to_openrouter] Server listening on port ${appConfig.port}`);
  console.log(`[send_to_openrouter] Webhook endpoint: http://localhost:${appConfig.port}${process.env.WEBHOOK_PATH || '/webhook'}`);
});

process.on('SIGINT', async () => {
  console.log('[send_to_openrouter] Shutting down...');
  server.close();
  await RTMSManager.stop();
  process.exit(0);
});
