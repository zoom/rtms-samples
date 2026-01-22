import { RTMSManager } from '../../library/javascript/rtmsManager/RTMSManager.js';
import WebhookManager from '../../library/javascript/webhookManager/WebhookManager.js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import http from 'http';

import { handleShareData, resetFrameCounter } from './saveSharescreen.js';

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
  mediaTypesFlag: 4,
  credentials: {
    meeting: {
      clientId: process.env.ZOOM_CLIENT_ID,
      clientSecret: process.env.ZOOM_CLIENT_SECRET,
      zoomSecretToken: process.env.ZOOM_SECRET_TOKEN,
    }
  },
  mediaParams: {
    deskshare: {
      codec: MEDIA_PARAMS.MEDIA_PAYLOAD_TYPE_JPG,
      resolution: MEDIA_PARAMS.MEDIA_RESOLUTION_HD,
      fps: 5,
    }
  }
};

console.log('[save_screen_share] App Configuration:', appConfig);
console.log('[save_screen_share] RTMS Configuration:', RTMSManager.redactSecrets(rtmsConfig));

const app = express();
const server = http.createServer(app);

app.use(express.static(path.join(__dirname, 'public')));

await RTMSManager.init(rtmsConfig);

const webhookManager = new WebhookManager({
  config: {
    webhookPath: process.env.WEBHOOK_PATH || '/webhook',
    zoomSecretToken: rtmsConfig.credentials.meeting.zoomSecretToken,
  },
  app: app
});

webhookManager.on('event', (event, payload) => {
  console.log('[save_screen_share] Webhook Event:', event);
  RTMSManager.handleEvent(event, payload);
});

webhookManager.setup();

RTMSManager.on('sharescreen', (payload) => {
  const { buffer, userId, timestamp, meetingId } = payload;
  handleShareData(buffer, userId, timestamp, meetingId);
});

RTMSManager.on('meeting.rtms_started', (payload) => {
  console.log('[save_screen_share] RTMS Started:', payload.meeting_uuid);
  resetFrameCounter();
});

RTMSManager.on('meeting.rtms_stopped', (payload) => {
  console.log('[save_screen_share] RTMS Stopped:', payload.meeting_uuid);
});

await RTMSManager.start();

server.listen(appConfig.port, () => {
  console.log(`[save_screen_share] Server listening on port ${appConfig.port}`);
  console.log(`[save_screen_share] Webhook endpoint: http://localhost:${appConfig.port}${process.env.WEBHOOK_PATH || '/webhook'}`);
});

process.on('SIGINT', async () => {
  console.log('[save_screen_share] Shutting down...');
  server.close();
  await RTMSManager.stop();
  process.exit(0);
});
