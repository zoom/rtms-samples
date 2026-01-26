import { RTMSManager } from '../../library/javascript/rtmsManager/RTMSManager.js';
import WebhookManager from '../../library/javascript/webhookManager/WebhookManager.js';
import WebsocketManager from '../../library/javascript/webSocketManager/WebsocketManager.js';
import { FrontendWssManager } from '../../library/javascript/rtmsManager/FrontendWssManager.js';
import { FrontendManager } from '../../library/javascript/rtmsManager/FrontendManager.js';
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
  managerType: process.env.RTMSTRIGGERMANAGERTYPE || 'webhook',
};

const s2sCredentials = {
  clientId: process.env.ZOOM_S2S_CLIENT_ID || null,
  clientSecret: process.env.ZOOM_S2S_CLIENT_SECRET || null,
  accountId: process.env.ZOOM_ACCOUNT_ID || null,
};

const websocketCredentials = {
  zoomWSURLForEvents: process.env.zoomWSURLForEvents || '',
  clientId: process.env.ZOOM_CLIENT_ID,
  clientSecret: process.env.ZOOM_CLIENT_SECRET,
};

const rtmsConfig = {
  logging: {
    enabled: true,
    logDir: path.join(__dirname, 'logs'),
    console: true
  },
  mediaSocketConnectionMode: process.env.MEDIA_SOCKET_CONNECTION_MODE || 'split',
  mediaTypesFlag: parseInt(process.env.MEDIA_TYPES_FLAG || '32'),
  credentials: {
    meeting: {
      clientId: process.env.ZOOM_CLIENT_ID,
      clientSecret: process.env.ZOOM_CLIENT_SECRET,
      zoomSecretToken: process.env.ZOOM_SECRET_TOKEN,
    },
    video: {
      videoClientId: process.env.VIDEO_CLIENT_ID,
      videoClientSecret: process.env.VIDEO_CLIENT_SECRET,
      videoSecretToken: process.env.VIDEO_SECRET_TOKEN,
    },
    s2s: s2sCredentials,
    websocket: websocketCredentials
  },
  mediaParams: {
    audio: {
      contentType: MEDIA_PARAMS.MEDIA_CONTENT_TYPE_RTP,
      sampleRate: MEDIA_PARAMS.AUDIO_SAMPLE_RATE_SR_16K,
      channel: MEDIA_PARAMS.AUDIO_CHANNEL_MONO,
      codec: MEDIA_PARAMS.MEDIA_PAYLOAD_TYPE_L16,
      dataOpt: MEDIA_PARAMS.MEDIA_DATA_OPTION_AUDIO_MIXED_STREAM,
      sendRate: 100,
    },
    video: {
      codec: MEDIA_PARAMS.MEDIA_PAYLOAD_TYPE_H264,
      dataOpt: MEDIA_PARAMS.MEDIA_DATA_OPTION_VIDEO_SINGLE_ACTIVE_STREAM,
      resolution: MEDIA_PARAMS.MEDIA_RESOLUTION_HD,
      fps: 25,
    },
    deskshare: {
      codec: MEDIA_PARAMS.MEDIA_PAYLOAD_TYPE_JPG,
      resolution: MEDIA_PARAMS.MEDIA_RESOLUTION_HD,
      fps: 1,
    },
    chat: {
      contentType: MEDIA_PARAMS.MEDIA_CONTENT_TYPE_TEXT,
    },
    transcript: {
      contentType: MEDIA_PARAMS.MEDIA_CONTENT_TYPE_TEXT,
      language: MEDIA_PARAMS.LANGUAGE_ID_ENGLISH,
    }
  }
};

console.log('[Consumer] App Configuration:', appConfig);
console.log('[Consumer] RTMS Configuration:', RTMSManager.redactSecrets(rtmsConfig));

// 1. Create Express App and HTTP Server
const app = express();
const server = http.createServer(app);

// 2. Initialize RTMS Manager (Core Logic)
await RTMSManager.init(rtmsConfig);

// 3. Initialize Frontend Manager (Static Files & Views)
const frontendManager = new FrontendManager({
  config: { 
    port: appConfig.port,
    serveStaticEnabled: process.env.SERVE_STATIC_ENABLED !== 'false',
    viewsPath: path.join(__dirname, '../../library/javascript/rtmsManager/public/views'),
    frontendWssUrl: process.env.FRONTEND_WSS_URL_TO_CONNECT_TO || ''
  },
  app: app
});
frontendManager.setup();

// 4. Initialize Frontend WSS Manager (Real-time Frontend Communication)
const frontendWssManager = new FrontendWssManager({
  config: { 
    frontendWssEnabled: true,
    frontendWssPath: process.env.FRONTEND_WSS_PATH || '/ws' 
  },
  server: server
});
frontendWssManager.setup();

// 5. Initialize Event Source Managers based on config
if (appConfig.managerType === 'webhook') {
  const webhookManager = new WebhookManager({
    config: {
      webhookPath: process.env.WEBHOOK_PATH || '/',
      zoomSecretToken: rtmsConfig.credentials.meeting.zoomSecretToken,
      videoSecretToken: rtmsConfig.credentials.video.videoSecretToken
    },
    app: app
  });

  webhookManager.on('event', (event, payload) => {
    console.log('[Consumer] Webhook Event:', event, payload);
    RTMSManager.handleEvent(event, payload);
  });

  webhookManager.setup();
  console.log('[Consumer] Webhook Manager initialized');

} else if (appConfig.managerType === 'websocket') {
  const websocketManager = new WebsocketManager({
    config: {
      zoomWSURLForEvents: rtmsConfig.credentials.websocket.zoomWSURLForEvents,
      clientId: rtmsConfig.credentials.websocket.clientId,
      clientSecret: rtmsConfig.credentials.websocket.clientSecret
    }
  });

  websocketManager.on('event', (event, payload) => {
    console.log('[Consumer] Websocket Event:', event, payload);
    RTMSManager.handleEvent(event, payload);
  });

  await websocketManager.start();
  console.log('[Consumer] Websocket Manager initialized');
}

// 6. Register media/event handlers
RTMSManager.on('audio', ({ buffer, userId, userName, timestamp, meetingId, streamId, productType }) => {
  // Process audio data here
});

RTMSManager.on('video', ({ buffer, userId, userName, timestamp, meetingId, streamId, productType }) => {
  // Process video data here
});

RTMSManager.on('sharescreen', ({ buffer, userId, userName, timestamp, meetingId, streamId, productType }) => {
  // Process screen share data here
});

RTMSManager.on('transcript', ({ text, userId, userName, timestamp, meetingId, streamId, productType, startTime, endTime, language, attribute }) => {
  console.log('[Consumer] Transcript:', { 
    text, 
    userId, 
    userName, 
    timestamp, 
    meetingId, 
    streamId, 
    productType, 
    startTime, 
    endTime, 
    language, 
    attribute 
  });
  
  frontendWssManager.broadcastToMeeting(meetingId, {
    type: 'transcript',
    text,
    userName,
    timestamp,
    language
  });
});

RTMSManager.on('chat', ({ text, userId, userName, timestamp, meetingId, streamId, productType }) => {
  console.log(`[Consumer] Chat (${productType}) from ${userName}: ${text}`);
  
  // Broadcast chat to frontend clients in the same meeting
  frontendWssManager.broadcastToMeeting(meetingId, {
    type: 'chat',
    text,
    userName,
    timestamp
  });
});

// Other events (optional logging)
RTMSManager.on('event', (eventData, meetingId, streamId, rtmsType) => {
  console.log('[Consumer] Event:', eventData, rtmsType);
});

RTMSManager.on('stream_state_changed', (msg, meetingId, streamId, rtmsType) => {
  console.log('[Consumer] Stream state changed:', msg, rtmsType);
});

RTMSManager.on('session_state_changed', (msg, meetingId, streamId, rtmsType) => {
  console.log('[Consumer] Session state changed:', msg, rtmsType);
});

// 7. Start the Server and RTMS Manager
await RTMSManager.start();

server.listen(appConfig.port, () => {
  console.log(`[Consumer] Server listening on port ${appConfig.port}`);
});

process.on('SIGINT', async () => {
  console.log('[Consumer] Shutting down...');
  server.close();
  await RTMSManager.stop();
  process.exit(0);
});
