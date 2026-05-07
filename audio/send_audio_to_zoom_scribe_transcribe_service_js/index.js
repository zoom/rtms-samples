import express from 'express';
import http from 'http';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

import { RTMSManager } from '../../library/javascript/rtmsManager/RTMSManager.js';
import WebhookManager from '../../library/javascript/webhookManager/WebhookManager.js';
import WebsocketManager from '../../library/javascript/webSocketManager/WebsocketManager.js';
import { AudioWindowBuffer } from './audioWindowBuffer.js';
import { ScribeClient } from './scribeClient.js';

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
const audioWindows = new AudioWindowBuffer({
  outputDir: path.join(__dirname, 'audio_windows'),
  sampleRate: 16000,
  channels: 1,
  bitsPerSample: 16,
  windowSeconds: envNumber('SCRIBE_WINDOW_SECONDS', 10),
  maxWindows: envNumber('SCRIBE_MAX_WINDOWS', 24)
});
const scribeClient = ScribeClient.fromEnv(process.env);

let activeMeetingId = null;
let activeStreamId = null;
let transcriptionInFlight = false;
const transcriptionQueue = [];

console.log('[ZoomScribe] App Configuration:', appConfig);
console.log('[ZoomScribe] RTMS Configuration:', RTMSManager.redactSecrets(rtmsConfig));
console.log('[ZoomScribe] Scribe Configuration:', {
  baseUrl: scribeClient.baseUrl,
  language: scribeClient.language,
  windowSeconds: audioWindows.windowSeconds,
  sampleRate: audioWindows.sampleRate,
  channels: audioWindows.channels
});

app.use(express.json());

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    activeMeetingId,
    activeStreamId,
    queuedWindows: transcriptionQueue.length,
    transcriptionInFlight
  });
});

await RTMSManager.init(rtmsConfig);

async function transcribeWindow(window) {
  const startedAt = Date.now();
  const result = await scribeClient.transcribeFile(window.filePath, {
    meetingId: activeMeetingId,
    streamId: activeStreamId,
    window
  });

  console.log('[ZoomScribe] Transcript result:', {
    fileName: window.fileName,
    requestId: result.requestId,
    model: result.model,
    durationSec: result.durationSec,
    elapsedMs: Date.now() - startedAt,
    text: result.text || '(no transcript text)'
  });
}

async function drainTranscriptionQueue() {
  if (transcriptionInFlight) return;
  transcriptionInFlight = true;

  try {
    while (transcriptionQueue.length > 0) {
      const window = transcriptionQueue.shift();
      try {
        await transcribeWindow(window);
      } catch (error) {
        console.error('[ZoomScribe] Transcription failed:', {
          fileName: window.fileName,
          message: error.message
        });
      }
    }
  } finally {
    transcriptionInFlight = false;
  }
}

function updateActiveRtmsState(event, payload = {}) {
  if (event === 'meeting.rtms_started') {
    activeMeetingId = payload.meeting_uuid;
    activeStreamId = payload.rtms_stream_id;
    audioWindows.reset();
    transcriptionQueue.length = 0;
  }

  if (event === 'meeting.rtms_stopped') {
    activeMeetingId = null;
    activeStreamId = null;
    audioWindows.reset();
    transcriptionQueue.length = 0;
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

RTMSManager.on('audio', ({ buffer, userId, userName, timestamp, streamId }) => {
  const windows = audioWindows.writeAudio(buffer, {
    meetingId: activeMeetingId,
    streamId,
    userId: userId ?? null,
    userName: userName ?? null,
    timestamp: timestamp ?? Date.now()
  });

  for (const window of windows) {
    console.log('[ZoomScribe] Audio window ready:', {
      fileName: window.fileName,
      bytes: window.size,
      durationSeconds: window.durationSeconds,
      sampleCount: window.sampleCount,
      userName: window.userName
    });
    transcriptionQueue.push(window);
  }

  drainTranscriptionQueue().catch((error) => {
    console.error('[ZoomScribe] Queue drain failed:', error.message);
  });
});

RTMSManager.on('error', (error) => {
  console.error('[ZoomScribe] RTMS Error:', error.message || error);
});

await RTMSManager.start();

server.listen(appConfig.port, () => {
  console.log(`[ZoomScribe] Server listening on port ${appConfig.port}`);
  console.log(`[ZoomScribe] Webhook endpoint: ${appConfig.webhookPath}`);
});

process.on('SIGINT', async () => {
  console.log('[ZoomScribe] Shutting down...');
  server.close();
  await RTMSManager.stop();
  process.exit(0);
});
