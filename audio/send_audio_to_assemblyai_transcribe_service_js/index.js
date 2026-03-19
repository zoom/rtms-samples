import { RTMSManager } from '../../library/javascript/rtmsManager/RTMSManager.js';
import WebhookManager from '../../library/javascript/webhookManager/WebhookManager.js';
import WebsocketManager from '../../library/javascript/webSocketManager/WebsocketManager.js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import http from 'http';

import { initializeAudioCollection, cleanupMeeting, sendAudioChunk } from './assemblyai.js';

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

console.log('[AssemblyAI] App Configuration:', appConfig);
console.log('[Consumer] RTMS Configuration:', RTMSManager.redactSecrets(rtmsConfig));

// 1. Create Express App and HTTP Server
const app = express();
const server = http.createServer(app);

app.use(express.json());

// 2. Initialize RTMS Manager (Core Logic)
await RTMSManager.init(rtmsConfig);

// 4. Initialize Event Source Managers based on config
if (appConfig.managerType === 'webhook') {
  const webhookManager = new WebhookManager({
    config: {
      webhookPath: process.env.WEBHOOK_PATH || '/',
      zoomSecretToken: rtmsConfig.credentials.meeting.zoomSecretToken,
    },
    app: app
  });

  webhookManager.on('event', (event, payload) => {
    console.log('[AssemblyAI] Webhook Event:', event);

    if (event === 'meeting.rtms_started' && payload?.meeting_uuid) {
      initializeAudioCollection(payload.meeting_uuid);
    }

    if (event === 'meeting.rtms_stopped' && payload?.meeting_uuid) {
      cleanupMeeting(payload.meeting_uuid);
    }

    RTMSManager.handleEvent(event, payload);
  });

  webhookManager.setup();
  console.log('[AssemblyAI] Webhook Manager initialized');

} else if (appConfig.managerType === 'websocket') {
  const websocketManager = new WebsocketManager({
    config: {
      zoomWSURLForEvents: rtmsConfig.credentials.websocket.zoomWSURLForEvents,
      clientId: rtmsConfig.credentials.websocket.clientId,
      clientSecret: rtmsConfig.credentials.websocket.clientSecret
    }
  });

  websocketManager.on('event', (event, payload) => {
    console.log('[AssemblyAI] Websocket Event:', event);

    if (event === 'meeting.rtms_started' && payload?.meeting_uuid) {
      initializeAudioCollection(payload.meeting_uuid);
    }

    if (event === 'meeting.rtms_stopped' && payload?.meeting_uuid) {
      cleanupMeeting(payload.meeting_uuid);
    }

    RTMSManager.handleEvent(event, payload);
  });

  await websocketManager.start();
  console.log('[AssemblyAI] Websocket Manager initialized');
}

// 5. Register media/event handlers
RTMSManager.on('audio', (event) => {
  sendAudioChunk(event.buffer, event.meetingId, event.userId);
});

RTMSManager.on('error', (error) => {
  console.error('[AssemblyAI] RTMS Error:', error.message);
});

// 6. Start the Server and RTMS Manager
await RTMSManager.start();

server.listen(appConfig.port, () => {
  console.log(`[AssemblyAI] Server listening on port ${appConfig.port}`);
});

process.on('SIGINT', async () => {
  console.log('[AssemblyAI] Shutting down...');
  server.close();
  await RTMSManager.stop();
  process.exit(0);
});
