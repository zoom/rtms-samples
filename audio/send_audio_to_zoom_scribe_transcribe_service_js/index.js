import express from 'express';
import { closeHttpServer, installGracefulShutdown } from '../../library/javascript/commonHelpers/gracefulShutdown.js';
import http from 'http';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

import { RTMSManager } from '../../library/javascript/rtmsManager/RTMSManager.js';
import WebhookManager from '../../library/javascript/webhookManager/WebhookManager.js';
import WebsocketManager from '../../library/javascript/webSocketManager/WebsocketManager.js';
import {
  initializeLiveScribeSession,
  sendAudioChunk,
  cleanupMeeting,
  closeLiveScribe,
  liveScribeConfig,
  activeSessionCount
} from './scribeClient.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '.env') });

const { MEDIA_PARAMS } = RTMSManager;

function envNumber(name, fallback) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function validateRequiredEnv(names) {
  const missing = names.filter((name) => !process.env[name] || String(process.env[name]).trim() === '');
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}

validateRequiredEnv([
  'ZOOM_CLIENT_ID',
  'ZOOM_CLIENT_SECRET',
  'ZOOM_SECRET_TOKEN',
  'ZOOM_API_KEY',
  'ZOOM_API_SECRET'
]);

const appConfig = {
  port: envNumber('PORT', 3000),
  managerType: process.env.RTMSTRIGGERMANAGERTYPE || 'webhook',
  webhookPath: process.env.WEBHOOK_PATH || '/webhook'
};

const rtmsConfig = {
  logging: {
    enabled: true,
    logDir: path.join(__dirname, 'logs'),
    console: true
  },
  mediaSocketConnectionMode: process.env.MEDIA_SOCKET_CONNECTION_MODE || 'split',
  mediaTypesFlag: RTMSManager.MEDIA.AUDIO,
  credentials: {
    meeting: {
      clientId: process.env.ZOOM_CLIENT_ID,
      clientSecret: process.env.ZOOM_CLIENT_SECRET,
      secretToken: process.env.ZOOM_SECRET_TOKEN
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
      // The live Scribe API expects 16 kHz mono PCM16 (LE) — request exactly that
      // from RTMS so audio can be forwarded verbatim, with no resampling.
      contentType: MEDIA_PARAMS.MEDIA_CONTENT_TYPE_RAW_AUDIO,
      sampleRate: MEDIA_PARAMS.AUDIO_SAMPLE_RATE_SR_16K,
      channel: MEDIA_PARAMS.AUDIO_CHANNEL_MONO,
      codec: MEDIA_PARAMS.MEDIA_PAYLOAD_TYPE_L16,
      dataOpt: MEDIA_PARAMS.MEDIA_DATA_OPTION_AUDIO_MIXED_STREAM,
      sendRate: 100
    }
  }
};

const app = express();
const server = http.createServer(app);

let activeMeetingId = null;
let activeStreamId = null;

console.log('[ZoomScribe] App Configuration:', appConfig);
console.log('[ZoomScribe] RTMS Configuration:', RTMSManager.redactSecrets(rtmsConfig));
console.log('[ZoomScribe] Live Scribe Configuration:', liveScribeConfig());

app.use(express.json({ verify: (req, _res, buffer) => { req.rawBody = Buffer.from(buffer); } }));

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    mode: 'live',
    activeMeetingId,
    activeStreamId,
    liveSessions: activeSessionCount()
  });
});

await RTMSManager.init(rtmsConfig);

// Open/close the live transcription WebSocket in step with the meeting lifecycle.
function updateActiveRtmsState(event, payload = {}) {
  if (event === 'meeting.rtms_started') {
    activeMeetingId = payload.meeting_uuid;
    activeStreamId = payload.rtms_stream_id;
    initializeLiveScribeSession(activeMeetingId);
  }

  if (event === 'meeting.rtms_stopped') {
    const endingMeetingId = payload.meeting_uuid || activeMeetingId;
    if (endingMeetingId) {
      cleanupMeeting(endingMeetingId).catch((error) => {
        console.error('[ZoomScribe] Live session cleanup failed:', error.message);
      });
    }
    if (endingMeetingId === activeMeetingId) {
      activeMeetingId = null;
      activeStreamId = null;
    }
  }
}

if (appConfig.managerType === 'webhook') {
  const webhookManager = new WebhookManager({
    config: {
      webhookPath: appConfig.webhookPath,
      zoomSecretToken: rtmsConfig.credentials.meeting.secretToken
    },
    app
  });

  webhookManager.on('event', (event, payload) => {
    updateActiveRtmsState(event, payload);
    console.log('[ZoomScribe] Webhook Event:', event);
    RTMSManager.handleEvent(event, payload);
  });

  webhookManager.setup();
  console.log('[ZoomScribe] Webhook Manager initialized');
} else if (appConfig.managerType === 'websocket') {
  const websocketManager = new WebsocketManager({
    config: {
      zoomWSURLForEvents: rtmsConfig.credentials.websocket.zoomWSURLForEvents,
      clientId: rtmsConfig.credentials.websocket.clientId,
      clientSecret: rtmsConfig.credentials.websocket.clientSecret
    }
  });

  websocketManager.on('event', (event, payload) => {
    updateActiveRtmsState(event, payload);
    console.log('[ZoomScribe] Websocket Event:', event);
    RTMSManager.handleEvent(event, payload);
  });

  await websocketManager.start();
  console.log('[ZoomScribe] Websocket Manager initialized');
}

// Forward each RTMS audio packet straight to the live Scribe WebSocket.
RTMSManager.on('audio', ({ buffer, userId }) => {
  if (!activeMeetingId) return;
  sendAudioChunk(buffer, activeMeetingId, userId ?? 0);
});

RTMSManager.on('error', (error) => {
  console.error('[ZoomScribe] RTMS Error:', error.message || error);
});

await RTMSManager.start();

server.listen(appConfig.port, () => {
  console.log(`[ZoomScribe] Server listening on port ${appConfig.port}`);
  console.log(`[ZoomScribe] Webhook endpoint: ${appConfig.webhookPath}`);
});

installGracefulShutdown({ name: 'ZoomScribe', cleanup: async () => {
  await closeHttpServer(server);
  await closeLiveScribe();
  await RTMSManager.stop();
} });
