import { RTMSManager } from '../../library/javascript/rtmsManager/RTMSManager.js';
import WebhookManager from '../../library/javascript/webhookManager/WebhookManager.js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import http from 'http';

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
  mediaSocketConnectionMode: process.env.MEDIA_SOCKET_CONNECTION_MODE || 'unified',
  mediaTypesFlag: 32, // Transcript only
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

console.log('[print_incoming_transcripts] App Configuration:', appConfig);
console.log('[print_incoming_transcripts] RTMS Configuration:', RTMSManager.redactSecrets(rtmsConfig));

// 1. Create Express App and HTTP Server
const app = express();
const server = http.createServer(app);

// 2. Initialize RTMS Manager
await RTMSManager.init(rtmsConfig);

// 3. Initialize Webhook Manager
const webhookManager = new WebhookManager({
  config: {
    webhookPath: process.env.WEBHOOK_PATH || '/webhook',
    zoomSecretToken: rtmsConfig.credentials.meeting.zoomSecretToken,
  },
  app: app
});

webhookManager.on('event', (event, payload) => {
  console.log('[print_incoming_transcripts] Webhook Event:', event);
  RTMSManager.handleEvent(event, payload);
});

webhookManager.setup();

// 4. Register transcript handler - just print to console
RTMSManager.on('transcript', ({ text, userId, userName, timestamp, meetingId }) => {
  console.log('='.repeat(60));
  console.log(`[TRANSCRIPT] Meeting: ${meetingId}`);
  console.log(`[TRANSCRIPT] User: ${userName} (${userId})`);
  console.log(`[TRANSCRIPT] Time: ${new Date(timestamp).toISOString()}`);
  console.log(`[TRANSCRIPT] Text: ${text}`);
  console.log('='.repeat(60));
});

RTMSManager.on('meeting.rtms_started', (payload) => {
  console.log('[print_incoming_transcripts] RTMS Started:', payload.meeting_uuid);
});

RTMSManager.on('meeting.rtms_stopped', (payload) => {
  console.log('[print_incoming_transcripts] RTMS Stopped:', payload.meeting_uuid);
});

// 5. Start the Server and RTMS Manager
await RTMSManager.start();

server.listen(appConfig.port, () => {
  console.log(`[print_incoming_transcripts] Server listening on port ${appConfig.port}`);
  console.log(`[print_incoming_transcripts] Webhook endpoint: http://localhost:${appConfig.port}${process.env.WEBHOOK_PATH || '/webhook'}`);
});

process.on('SIGINT', async () => {
  console.log('[print_incoming_transcripts] Shutting down...');
  server.close();
  await RTMSManager.stop();
  process.exit(0);
});
