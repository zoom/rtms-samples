import { RTMSManager } from '../../library/javascript/rtmsManager/RTMSManager.js';
import WebhookManager from '../../library/javascript/webhookManager/WebhookManager.js';
import WebsocketManager from '../../library/javascript/webSocketManager/WebsocketManager.js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import { closeHttpServer, installGracefulShutdown } from '../../library/javascript/commonHelpers/gracefulShutdown.js';
import http from 'http';

import { azureSpeechToTextStream } from "./azureSpeechToText.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '.env') });

const { MEDIA_PARAMS } = RTMSManager;

const appConfig = {
  port: process.env.PORT || 3000,
  managerType: process.env.RTMSTRIGGERMANAGERTYPE || 'webhook',
};

const rtmsConfig = {
  mediaSocketConnectionMode: process.env.MEDIA_SOCKET_CONNECTION_MODE || 'split',
  mediaTypesFlag: 1, // Audio only
  credentials: {
    meeting: {
      clientId: process.env.ZOOM_CLIENT_ID,
      clientSecret: process.env.ZOOM_CLIENT_SECRET,
      zoomSecretToken: process.env.ZOOM_SECRET_TOKEN,
    },
    s2s: {
      clientId: process.env.ZOOM_S2S_CLIENT_ID || null,
      clientSecret: process.env.ZOOM_S2S_CLIENT_SECRET || null,
      accountId: process.env.ZOOM_ACCOUNT_ID || null,
    },
    websocket: {
      zoomWSURLForEvents: process.env.zoomWSURLForEvents || '',
      clientId: process.env.ZOOM_CLIENT_ID,
      clientSecret: process.env.ZOOM_CLIENT_SECRET,
    }
  },
  mediaParams: {
    audio: {
      contentType: MEDIA_PARAMS.MEDIA_CONTENT_TYPE_RAW_AUDIO,
      sampleRate: MEDIA_PARAMS.AUDIO_SAMPLE_RATE_SR_16K,
      channel: MEDIA_PARAMS.AUDIO_CHANNEL_MONO,
      codec: MEDIA_PARAMS.MEDIA_PAYLOAD_TYPE_L16,
      dataOpt: MEDIA_PARAMS.MEDIA_DATA_OPTION_AUDIO_MIXED_STREAM,
      sendRate: 100,
    }
  }
};

console.log('[Azure Speech] App Configuration:', appConfig);
console.log('[Consumer] RTMS Configuration:', RTMSManager.redactSecrets(rtmsConfig));

// 1. Create Express App and HTTP Server
const app = express();
const server = http.createServer(app);

app.use(express.json({ verify: (req, _res, buffer) => { req.rawBody = Buffer.from(buffer); } }));

// 2. Initialize RTMS Manager (Core Logic)
await RTMSManager.init(rtmsConfig);

// 3. Initialize Event Source Managers based on config
if (appConfig.managerType === 'webhook') {
  const webhookManager = new WebhookManager({
    config: {
      webhookPath: process.env.WEBHOOK_PATH || '/',
      zoomSecretToken: rtmsConfig.credentials.meeting.zoomSecretToken,
    },
    app: app
  });

  webhookManager.on('event', (event, payload) => {
    console.log('[Azure Speech] Webhook Event:', event);
    RTMSManager.handleEvent(event, payload);
  });

  webhookManager.setup();
  console.log('[Azure Speech] Webhook Manager initialized');

} else if (appConfig.managerType === 'websocket') {
  const websocketManager = new WebsocketManager({
    config: {
      zoomWSURLForEvents: rtmsConfig.credentials.websocket.zoomWSURLForEvents,
      clientId: rtmsConfig.credentials.websocket.clientId,
      clientSecret: rtmsConfig.credentials.websocket.clientSecret
    }
  });

  websocketManager.on('event', (event, payload) => {
    console.log('[Azure Speech] Websocket Event:', event);
    RTMSManager.handleEvent(event, payload);
  });

  await websocketManager.start();
  console.log('[Azure Speech] Websocket Manager initialized');
}

// 4. Register media/event handlers
RTMSManager.on('audio', (event) => {
  azureSpeechToTextStream(event.buffer);
});

RTMSManager.on('error', (error) => {
  console.error('[Azure Speech] RTMS Error:', error.message);
});

// 5. Start the Server and RTMS Manager
await RTMSManager.start();

server.listen(appConfig.port, () => {
  console.log(`[Azure Speech] Server listening on port ${appConfig.port}`);
});

installGracefulShutdown({ name: 'Azure Speech', cleanup: async () => {
  await closeHttpServer(server);
  await RTMSManager.stop();
} });
