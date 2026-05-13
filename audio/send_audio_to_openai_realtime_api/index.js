import { RTMSManager } from '../../library/javascript/rtmsManager/RTMSManager.js';
import WebhookManager from '../../library/javascript/webhookManager/WebhookManager.js';
import WebsocketManager from '../../library/javascript/webSocketManager/WebsocketManager.js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import http from 'http';

import { initializeRealtimeSession, cleanupMeeting, sendAudioChunk, closeOpenAIRealtime } from './openaiRealtime.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '.env') });

const { MEDIA_PARAMS } = RTMSManager;

const appConfig = {
  port: process.env.PORT || 3000,
  managerType: process.env.RTMSTRIGGERMANAGERTYPE || 'webhook',
};

const sourceAudioSampleRate = Number.parseInt(process.env.AUDIO_SAMPLE_RATE || '48000', 10);

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
      sampleRate: rtmsAudioSampleRateParam(sourceAudioSampleRate),
      channel: MEDIA_PARAMS.AUDIO_CHANNEL_MONO,
      codec: MEDIA_PARAMS.MEDIA_PAYLOAD_TYPE_L16,
      dataOpt: MEDIA_PARAMS.MEDIA_DATA_OPTION_AUDIO_MIXED_STREAM,
      sendRate: 100,
    }
  }
};

console.log('[OpenAI Realtime] App Configuration:', appConfig);
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
    console.log('[OpenAI Realtime] Webhook Event:', event);

    if (event === 'meeting.rtms_started' && payload?.meeting_uuid) {
      initializeRealtimeSession(payload.meeting_uuid);
    }

    if (event === 'meeting.rtms_stopped' && payload?.meeting_uuid) {
      cleanupMeeting(payload.meeting_uuid);
    }

    RTMSManager.handleEvent(event, payload);
  });

  webhookManager.setup();
  console.log('[OpenAI Realtime] Webhook Manager initialized');

} else if (appConfig.managerType === 'websocket') {
  const websocketManager = new WebsocketManager({
    config: {
      zoomWSURLForEvents: rtmsConfig.credentials.websocket.zoomWSURLForEvents,
      clientId: rtmsConfig.credentials.websocket.clientId,
      clientSecret: rtmsConfig.credentials.websocket.clientSecret
    }
  });

  websocketManager.on('event', (event, payload) => {
    console.log('[OpenAI Realtime] Websocket Event:', event);

    if (event === 'meeting.rtms_started' && payload?.meeting_uuid) {
      initializeRealtimeSession(payload.meeting_uuid);
    }

    if (event === 'meeting.rtms_stopped' && payload?.meeting_uuid) {
      cleanupMeeting(payload.meeting_uuid);
    }

    RTMSManager.handleEvent(event, payload);
  });

  await websocketManager.start();
  console.log('[OpenAI Realtime] Websocket Manager initialized');
}

// 5. Register media/event handlers
RTMSManager.on('audio', (event) => {
  sendAudioChunk(event.buffer, event.meetingId, event.userId);
});

RTMSManager.on('error', (error) => {
  console.error('[OpenAI Realtime] RTMS Error:', error.message);
});

// 6. Start the Server and RTMS Manager
await RTMSManager.start();

server.listen(appConfig.port, () => {
  console.log(`[OpenAI Realtime] Server listening on port ${appConfig.port}`);
});

process.on('SIGINT', async () => {
  console.log('[OpenAI Realtime] Shutting down...');
  server.close();
  await closeOpenAIRealtime();
  await RTMSManager.stop();
  process.exit(0);
});

function rtmsAudioSampleRateParam(sampleRateHz) {
  const sampleRateMap = {
    8000: MEDIA_PARAMS.AUDIO_SAMPLE_RATE_SR_8K,
    16000: MEDIA_PARAMS.AUDIO_SAMPLE_RATE_SR_16K,
    32000: MEDIA_PARAMS.AUDIO_SAMPLE_RATE_SR_32K,
    48000: MEDIA_PARAMS.AUDIO_SAMPLE_RATE_SR_48K,
  };

  const sampleRate = sampleRateMap[sampleRateHz];
  if (sampleRate === undefined) {
    throw new Error(`Unsupported RTMS AUDIO_SAMPLE_RATE=${sampleRateHz}. Use 8000, 16000, 32000, or 48000.`);
  }

  return sampleRate;
}
