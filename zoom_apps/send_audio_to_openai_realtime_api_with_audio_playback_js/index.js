import { RTMSManager } from '../../library/javascript/rtmsManager/RTMSManager.js';
import WebhookManager from '../../library/javascript/webhookManager/WebhookManager.js';
import WebsocketManager from '../../library/javascript/webSocketManager/WebsocketManager.js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import { closeHttpServer, installGracefulShutdown } from '../../library/javascript/commonHelpers/gracefulShutdown.js';
import http from 'http';

import { setupFrontendWss, broadcastToFrontendClients, frontendClientCount } from './frontendWss.js';
import {
  initializeRealtimeSession,
  cleanupMeeting,
  sendAudioChunk,
  truncateRealtimeAudioPlayback,
  closeOpenAIRealtime,
  setRealtimeFrontendCallbacks,
} from './openaiRealtime.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '.env') });

const { MEDIA_PARAMS } = RTMSManager;

const appConfig = {
  port: process.env.PORT || 5050,
  managerType: process.env.MODE || process.env.RTMSTRIGGERMANAGERTYPE || 'webhook',
  webhookPath: process.env.WEBHOOK_PATH || '/webhook',
  frontendWssUrl: process.env.FRONTEND_WSS_URL_TO_CONNECT_TO || '',
};

const sourceAudioSampleRate = Number.parseInt(process.env.AUDIO_SAMPLE_RATE || '48000', 10);

const rtmsConfig = {
  logging: process.env.RTMS_LOGGING || 'info',
  logDir: path.join(__dirname, 'logs'),
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
    },
  },
  mediaParams: {
    audio: {
      contentType: MEDIA_PARAMS.MEDIA_CONTENT_TYPE_RAW_AUDIO,
      sampleRate: rtmsAudioSampleRateParam(sourceAudioSampleRate),
      channel: MEDIA_PARAMS.AUDIO_CHANNEL_MONO,
      codec: MEDIA_PARAMS.MEDIA_PAYLOAD_TYPE_L16,
      dataOpt: MEDIA_PARAMS.MEDIA_DATA_OPTION_AUDIO_MIXED_STREAM,
      sendRate: 100,
    },
  },
};

console.log('[OpenAI Realtime Playback] App Configuration:', appConfig);
console.log('[OpenAI Realtime Playback] RTMS Configuration:', RTMSManager.redactSecrets(rtmsConfig));

const app = express();
const server = http.createServer(app);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'public'));
app.use(express.json({ verify: (req, _res, buffer) => { req.rawBody = Buffer.from(buffer); } }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.render('index', {
    websocket_url: appConfig.frontendWssUrl || deriveFrontendWssUrl(req),
  });
});

setRealtimeFrontendCallbacks({
  broadcast: broadcastToFrontendClients,
});

const frontendWss = setupFrontendWss(server, {
  onClientReady: async (data) => {
    console.log('[Zoom App] Client ready:', data);
    broadcastToFrontendClients({
      type: 'status',
      data: `Frontend connected. Active frontend clients: ${frontendClientCount()}`,
    });
  },
  onPlaybackInterrupted: async ({ data, metadata }) => {
    truncateRealtimeAudioPlayback({
      meetingUuid: metadata?.meeting_uuid || metadata?.meetingUUID || null,
      responseId: data.responseId,
      itemId: data.itemId,
      contentIndex: data.contentIndex,
      audioEndMs: data.audioEndMs,
      skipCancel: data.skipCancel,
    });
  },
});

await RTMSManager.init(rtmsConfig);

if (appConfig.managerType === 'webhook') {
  const webhookManager = new WebhookManager({
    config: {
      webhookPath: appConfig.webhookPath,
      zoomSecretToken: rtmsConfig.credentials.meeting.zoomSecretToken,
    },
    app,
  });

  webhookManager.on('event', (event, payload) => {
    console.log('[OpenAI Realtime Playback] Webhook Event:', event);
    handleRtmsLifecycleEvent(event, payload);
    RTMSManager.handleEvent(event, payload);
  });

  webhookManager.setup();
  console.log('[OpenAI Realtime Playback] Webhook Manager initialized');
} else if (appConfig.managerType === 'websocket') {
  const websocketManager = new WebsocketManager({
    config: {
      zoomWSURLForEvents: rtmsConfig.credentials.websocket.zoomWSURLForEvents,
      clientId: rtmsConfig.credentials.websocket.clientId,
      clientSecret: rtmsConfig.credentials.websocket.clientSecret,
    },
  });

  websocketManager.on('event', (event, payload) => {
    console.log('[OpenAI Realtime Playback] Websocket Event:', event);
    handleRtmsLifecycleEvent(event, payload);
    RTMSManager.handleEvent(event, payload);
  });

  await websocketManager.start();
  console.log('[OpenAI Realtime Playback] Websocket Manager initialized');
}

RTMSManager.on('audio', (event) => {
  sendAudioChunk(event.buffer, event.meetingId, event.userId);
});

RTMSManager.on('error', (error) => {
  console.error('[OpenAI Realtime Playback] RTMS Error:', error.message);
  broadcastToFrontendClients({ type: 'error', data: error.message });
});

await RTMSManager.start();

server.listen(appConfig.port, () => {
  console.log(`[OpenAI Realtime Playback] Server listening on port ${appConfig.port}`);
  console.log(`[OpenAI Realtime Playback] Webhook path ${appConfig.webhookPath}`);
  console.log(`[OpenAI Realtime Playback] Frontend WebSocket path /ws`);
});

installGracefulShutdown({ name: 'OpenAI Realtime Playback', cleanup: async () => {
  await closeOpenAIRealtime();
  await RTMSManager.stop();
  for (const client of frontendWss.clients) client.terminate();
  await new Promise((resolve) => frontendWss.close(resolve));
  await closeHttpServer(server);
} });

function handleRtmsLifecycleEvent(event, payload) {
  const id = payload?.meeting_uuid || payload?.session_id;
  if (!id) {
    return;
  }

  if (event.endsWith('.rtms_started')) {
    initializeRealtimeSession(id);
    broadcastToFrontendClients({ type: 'status', data: `RTMS started: ${id}` });
  }

  if (event.endsWith('.rtms_stopped')) {
    cleanupMeeting(id);
    broadcastToFrontendClients({ type: 'status', data: `RTMS stopped: ${id}` });
  }
}

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

function deriveFrontendWssUrl(req) {
  const forwardedProto = req.get('x-forwarded-proto');
  const proto = forwardedProto || req.protocol;
  const wsProto = proto === 'https' ? 'wss' : 'ws';
  return `${wsProto}://${req.get('host')}/ws`;
}
