import { RTMSManager } from '../../library/javascript/rtmsManager/RTMSManager.js';
import { FrontendWssManager } from '../../library/javascript/rtmsManager/FrontendWssManager.js';
import WebhookManager from '../../library/javascript/webhookManager/WebhookManager.js';
import WebsocketManager from '../../library/javascript/webSocketManager/WebsocketManager.js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import { closeHttpServer, installGracefulShutdown } from '../../library/javascript/commonHelpers/gracefulShutdown.js';
import http from 'http';

import {
  decryptZoomAppContext,
  mintFrontendWsToken,
  createAuthorizeRegistration,
} from './frontendAuth.js';
import {
  initializeRealtimeSession,
  cleanupMeeting,
  sendAudioChunk,
  sendTextMessageToRealtime,
  truncateRealtimeAudioPlayback,
  setSpeakerSafeMode,
  setClientPlaybackActive,
  closeMicrosoftVoiceLive,
  setRealtimeFrontendCallbacks,
  validateVoiceLiveConfig,
} from './microsoftVoiceLive.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '.env') });

const { MEDIA_PARAMS } = RTMSManager;

const appConfig = {
  port: process.env.PORT || 5050,
  managerType: process.env.MODE || process.env.RTMSTRIGGERMANAGERTYPE || 'webhook',
  webhookPath: process.env.WEBHOOK_PATH || '/webhook',
  frontendWssUrl: process.env.FRONTEND_WSS_URL_TO_CONNECT_TO || '',
  frontendWssPath: '/ws',
};

const sourceAudioSampleRate = Number.parseInt(process.env.AUDIO_SAMPLE_RATE || '48000', 10);

const rtmsConfig = {
  logging: process.env.RTMS_LOGGING || 'info',
  logDir: path.join(__dirname, 'logs'),
  mediaTypes: RTMSManager.MEDIA.AUDIO,
  credentials: {
    meeting: {
      clientId: process.env.ZOOM_CLIENT_ID,
      clientSecret: process.env.ZOOM_CLIENT_SECRET,
      secretToken: process.env.ZOOM_SECRET_TOKEN,
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

const configCheck = validateVoiceLiveConfig();
if (!configCheck.valid) {
  console.warn(`[Microsoft Voice Live Playback] Configuration warning: ${configCheck.error}`);
}

console.log('[Microsoft Voice Live Playback] App Configuration:', appConfig);
console.log('[Microsoft Voice Live Playback] RTMS Configuration:', RTMSManager.redactSecrets(rtmsConfig));

const wsSigningSecret = process.env.FRONTEND_WSS_SIGNING_SECRET || process.env.ZOOM_CLIENT_SECRET || '';

const app = express();
const server = http.createServer(app);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'public'));
app.use(express.json({ verify: (req, _res, buffer) => { req.rawBody = Buffer.from(buffer); } }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  const verifiedContext = decryptZoomAppContext(
    req.headers['x-zoom-app-context'],
    process.env.ZOOM_CLIENT_SECRET,
  );
  const wsAuthToken = verifiedContext
    ? mintFrontendWsToken(verifiedContext, wsSigningSecret)
    : (process.env.ALLOW_PRE_RTMS_REGISTRATION === 'true' ? (process.env.FRONTEND_WSS_AUTH_TOKEN || '') : '');

  res.render('index', {
    websocket_url: appConfig.frontendWssUrl || deriveFrontendWssUrl(req),
    ws_auth_token: wsAuthToken,
  });
});

await RTMSManager.init(rtmsConfig);

const frontendWssManager = new FrontendWssManager({
  config: {
    frontendWssEnabled: true,
    frontendWssPath: appConfig.frontendWssPath,
  },
  server,
  authorizeRegistration: createAuthorizeRegistration({
    getActiveConnections: () => RTMSManager.getActiveConnections(),
    signingSecret: wsSigningSecret,
    staticAuthToken: process.env.FRONTEND_WSS_AUTH_TOKEN || '',
    allowPreRtmsRegistration: process.env.ALLOW_PRE_RTMS_REGISTRATION === 'true',
  }),
});
frontendWssManager.setup();

// Handle authenticated application messages on registered meeting sockets
if (frontendWssManager.wss) {
  frontendWssManager.wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      if (!ws.meetingUUID || !ws.userID) {
        return; // Unauthenticated sockets may only complete `register` in FrontendWssManager
      }

      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }

      try {
        switch (message.type) {
          case 'register':
          case 'pong':
            break;
          case 'heartbeat':
            if (ws.readyState === 1) {
              ws.send(JSON.stringify({ type: 'heartbeat_ack', timestamp: Date.now() }));
            }
            break;
          case 'playback_interrupted':
            truncateRealtimeAudioPlayback({
              meetingUuid: ws.meetingUUID,
              responseId: message.data?.responseId,
              itemId: message.data?.itemId,
              contentIndex: message.data?.contentIndex,
              audioEndMs: message.data?.audioEndMs,
              skipCancel: message.data?.skipCancel,
            });
            break;
          case 'speaker_safe_mode':
            setSpeakerSafeMode(ws.meetingUUID, Boolean(message.data?.enabled));
            break;
          case 'playback_state':
            setClientPlaybackActive(ws.meetingUUID, Boolean(message.data?.playing));
            break;
          case 'text':
            sendTextMessageToRealtime(String(message.data || ''), ws.meetingUUID);
            break;
          default:
            break;
        }
      } catch (error) {
        console.error('[Microsoft Voice Live Playback] Frontend message error:', error.message);
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'error', data: error.message || 'Frontend message failed' }));
        }
      }
    });
  });
}

setRealtimeFrontendCallbacks({
  broadcastToMeeting: (meetingUuid, message) => {
    frontendWssManager.broadcastToMeeting(meetingUuid, message);
  },
});

let websocketManager = null;

if (appConfig.managerType === 'webhook') {
  const webhookManager = new WebhookManager({
    config: {
      webhookPath: appConfig.webhookPath,
      zoomSecretToken: rtmsConfig.credentials.meeting.secretToken,
    },
    app,
  });

  webhookManager.on('event', (event, payload) => {
    console.log('[Microsoft Voice Live Playback] Webhook Event:', event);
    handleRtmsLifecycleEvent(event, payload);
    RTMSManager.handleEvent(event, payload);
  });

  webhookManager.setup();
  console.log('[Microsoft Voice Live Playback] Webhook Manager initialized');
} else if (appConfig.managerType === 'websocket') {
  websocketManager = new WebsocketManager({
    config: {
      zoomWSURLForEvents: rtmsConfig.credentials.websocket.zoomWSURLForEvents,
      clientId: rtmsConfig.credentials.websocket.clientId,
      clientSecret: rtmsConfig.credentials.websocket.clientSecret,
    },
  });

  websocketManager.on('event', (event, payload) => {
    console.log('[Microsoft Voice Live Playback] Websocket Event:', event);
    handleRtmsLifecycleEvent(event, payload);
    RTMSManager.handleEvent(event, payload);
  });

  await websocketManager.start();
  console.log('[Microsoft Voice Live Playback] Websocket Manager initialized');
}

RTMSManager.on('audio', (event) => {
  sendAudioChunk(event.buffer, event.meetingId, event.userId);
});

RTMSManager.on('error', (error) => {
  console.error('[Microsoft Voice Live Playback] RTMS Error:', error.message);
  const meetingId = error?.meetingId || error?.meetingUuid || null;
  if (meetingId) {
    frontendWssManager.broadcastToMeeting(meetingId, { type: 'error', data: error.message });
  }
});

await RTMSManager.start();

server.listen(appConfig.port, () => {
  console.log(`[Microsoft Voice Live Playback] Server listening on port ${appConfig.port}`);
  console.log(`[Microsoft Voice Live Playback] Webhook path ${appConfig.webhookPath}`);
  console.log(`[Microsoft Voice Live Playback] Frontend WebSocket path ${appConfig.frontendWssPath}`);
});

installGracefulShutdown({
  name: 'Microsoft Voice Live Playback',
  cleanup: async () => {
    await closeMicrosoftVoiceLive();
    if (websocketManager) {
      websocketManager.stop();
    }
    await RTMSManager.stop();
    frontendWssManager.stop();
    await closeHttpServer(server);
  },
});

function handleRtmsLifecycleEvent(event, payload) {
  const id = payload?.meeting_uuid || payload?.session_id;
  if (!id) {
    return;
  }

  if (event.endsWith('.rtms_started')) {
    initializeRealtimeSession(id);
    frontendWssManager.broadcastToMeeting(id, { type: 'status', data: `RTMS started: ${id}` });
  }

  if (event.endsWith('.rtms_stopped')) {
    cleanupMeeting(id);
    frontendWssManager.broadcastToMeeting(id, { type: 'status', data: `RTMS stopped: ${id}` });
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
  return `${wsProto}://${req.get('host')}${appConfig.frontendWssPath}`;
}
