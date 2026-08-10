import { RTMSManager } from '../../library/javascript/rtmsManager/RTMSManager.js';
import WebhookManager from '../../library/javascript/webhookManager/WebhookManager.js';
import WebsocketManager from '../../library/javascript/webSocketManager/WebsocketManager.js';
import { FrontendWssManager } from '../../library/javascript/rtmsManager/FrontendWssManager.js';
import { FrontendManager } from '../../library/javascript/rtmsManager/FrontendManager.js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import util from 'node:util';
import express from 'express';
import http from 'http';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '.env') });

const { MEDIA_PARAMS } = RTMSManager;
const VALID_MEDIA_TYPE_FLAGS = new Set([1, 2, 3, 4, 5, 6, 8, 9, 10, 12, 16, 17, 18, 20, 24, 32]);

function normalizeMode(value, fallback) {
  return String(value || fallback).trim().toLowerCase();
}

function getMediaTypesFlagFromEnv() {
  const rawValue = String(process.env.MEDIA_TYPES_FLAG || '2').trim();
  const parsedValue = Number.parseInt(rawValue, 10);

  if (!Number.isInteger(parsedValue) || !VALID_MEDIA_TYPE_FLAGS.has(parsedValue)) {
    throw new Error(
      `[Consumer] Unsupported MEDIA_TYPES_FLAG: ${rawValue}. Use a valid RTMS media bitmask such as 1 (audio), 2 (video), 3 (audio+video), 9 (audio+transcript), or 32 (all).`
    );
  }

  return parsedValue;
}

function getAudioDataOptFromEnv() {
  const audioMode = normalizeMode(process.env.AUDIO_STREAM_MODE, 'mixed');
  switch (audioMode) {
    case 'mixed':
      return MEDIA_PARAMS.MEDIA_DATA_OPTION_AUDIO_MIXED_STREAM;
    case 'multi':
    case 'multiple':
    case 'individual':
      return MEDIA_PARAMS.MEDIA_DATA_OPTION_AUDIO_MULTI_STREAMS;
    default:
      throw new Error(`[Consumer] Unsupported AUDIO_STREAM_MODE: ${process.env.AUDIO_STREAM_MODE}`);
  }
}

function getVideoDataOptFromEnv() {
  const videoMode = normalizeMode(process.env.VIDEO_STREAM_MODE, 'active');
  switch (videoMode) {
    case 'active':
    case 'active_speaker':
    case 'single_active':
      return MEDIA_PARAMS.MEDIA_DATA_OPTION_VIDEO_SINGLE_ACTIVE_STREAM;
    case 'individual':
    case 'single_individual':
      return MEDIA_PARAMS.MEDIA_DATA_OPTION_VIDEO_SINGLE_INDIVIDUAL_STREAM;
    case 'speaker':
    case 'speaker_view':
    case 'mixed_speaker':
      return MEDIA_PARAMS.MEDIA_DATA_OPTION_VIDEO_SINGLE_ACTIVE_STREAM;
    default:
      throw new Error(`[Consumer] Unsupported VIDEO_STREAM_MODE: ${process.env.VIDEO_STREAM_MODE}`);
  }
}

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
  mediaTypesFlag: getMediaTypesFlagFromEnv(),
  credentials: {
    meeting: {
      clientId: process.env.ZOOM_CLIENT_ID,
      clientSecret: process.env.ZOOM_CLIENT_SECRET,
      secretToken: process.env.ZOOM_SECRET_TOKEN,
    },
    videoSdk: {
      clientId: process.env.VIDEO_CLIENT_ID,
      clientSecret: process.env.VIDEO_CLIENT_SECRET,
      secretToken: process.env.VIDEO_SECRET_TOKEN,
    },
    s2s: s2sCredentials,
    websocket: websocketCredentials
  },
  mediaParams: {
    audio: {
      contentType: MEDIA_PARAMS.MEDIA_CONTENT_TYPE_RAW_AUDIO,
      sampleRate: MEDIA_PARAMS.AUDIO_SAMPLE_RATE_SR_16K,
      channel: MEDIA_PARAMS.AUDIO_CHANNEL_MONO,
      codec: MEDIA_PARAMS.MEDIA_PAYLOAD_TYPE_L16,
      dataOpt: getAudioDataOptFromEnv(),
      sendRate: 100,
    },
    video: {
      contentType: MEDIA_PARAMS.MEDIA_CONTENT_TYPE_RAW_VIDEO,
      codec: MEDIA_PARAMS.MEDIA_PAYLOAD_TYPE_H264,
      dataOpt: getVideoDataOptFromEnv(),
      resolution: MEDIA_PARAMS.MEDIA_RESOLUTION_HD,
      fps: 25,
    },
    deskshare: {
      contentType: MEDIA_PARAMS.MEDIA_CONTENT_TYPE_RAW_VIDEO,
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
console.log('[Consumer] Audio stream mode:', normalizeMode(process.env.AUDIO_STREAM_MODE, 'mixed'));
console.log('[Consumer] Video stream mode:', normalizeMode(process.env.VIDEO_STREAM_MODE, 'active'));
const autoSelectedVideoUserIds = new Map();

function isIndividualVideoMode() {
  return normalizeMode(process.env.VIDEO_STREAM_MODE, 'active') === 'individual';
}

function getValidIndividualVideoCandidates(availableParticipants = []) {
  return availableParticipants
    .filter((participant) => participant && participant.userId != null && String(participant.userId).trim() !== '')
    .map((participant) => ({
      userId: participant.userId,
      userName: participant.userName || null
    }));
}

function trySubscribeAvailableIndividualVideo(streamId, availableParticipants = []) {
  if (!isIndividualVideoMode()) return;

  const candidates = getValidIndividualVideoCandidates(availableParticipants);
  if (candidates.length === 0) {
    console.log('[Consumer] No valid individual video user ID available yet:', { streamId });
    return;
  }

  console.log('[Consumer] Individual video candidates:', { streamId, candidates });

  const currentUserId = RTMSManager.getCurrentVideoSubscription(streamId);
  if (currentUserId != null) {
    const currentUserIdStr = String(currentUserId);
    if (candidates.some((participant) => String(participant.userId) === currentUserIdStr)) {
      return;
    }
  }

  const selectedParticipant = candidates[0];
  const lastAutoSelectedUserId = autoSelectedVideoUserIds.get(streamId);
  if (lastAutoSelectedUserId != null && String(lastAutoSelectedUserId) === String(selectedParticipant.userId)) {
    return;
  }

  try {
    console.log('[Consumer] Sending VIDEO_SUBSCRIPTION_REQ:', {
      streamId,
      userId: selectedParticipant.userId,
      subscribe: true,
      timestamp: Date.now()
    });
    RTMSManager.subscribeToIndividualVideo(streamId, selectedParticipant.userId);
    autoSelectedVideoUserIds.set(streamId, selectedParticipant.userId);
    console.log('[Consumer] Auto-subscribing individual video user from RTMS event:', {
      streamId,
      userId: selectedParticipant.userId,
      userName: selectedParticipant.userName
    });
  } catch (error) {
    console.error('[Consumer] Failed to auto-subscribe individual video user:', error.message);
  }
}

// 1. Create Express App and HTTP Server
const app = express();
const server = http.createServer(app);

// 2. Initialize RTMS Manager (Core Logic)
await RTMSManager.init(rtmsConfig);

// Handle RTMS errors to prevent unhandled 'error' event crashes
RTMSManager.instance.on('error', (err) => {
  console.error('[Consumer] RTMS Error:', err.toString ? err.toString() : err);
});

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
      zoomSecretToken: rtmsConfig.credentials.meeting.secretToken,
      videoSecretToken: rtmsConfig.credentials.videoSdk.secretToken
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
  console.log('[Consumer] Audio packet received:', {
    streamId,
    userId: userId ?? null,
    userName: userName ?? null,
    timestamp: timestamp ?? null,
    bytes: buffer?.length ?? null
  });
});

RTMSManager.on('video', ({ buffer, userId, userName, timestamp, meetingId, streamId, productType }) => {
  console.log('[Consumer] Video packet received:', {
    streamId,
    userId: userId ?? null,
    userName: userName ?? null,
    timestamp: timestamp ?? null,
    bytes: buffer?.length ?? null
  });
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

RTMSManager.on('chat', ({ text, userId, userName, sender, timestamp, meetingId, streamId, productType }) => {
  const displayName = userName ?? sender?.userName ?? sender?.user_name ?? `user ${userId ?? 'unknown'}`;
  console.log(`[Consumer] Chat (${productType}) from ${displayName}: ${text}`);
  
  // Broadcast chat to frontend clients in the same meeting
  frontendWssManager.broadcastToMeeting(meetingId, {
    type: 'chat',
    text,
    userName: displayName,
    timestamp
  });
});

// Other events (optional logging)
RTMSManager.on('event', (eventData) => {
  console.log('[Consumer] Event:', util.inspect(eventData, { depth: null, colors: true }));

  if (eventData?.eventType === 3 && Array.isArray(eventData.data?.participants)) {
    console.log('[Consumer] Participant IDs:', eventData.data.participants.map((participant) => ({
      userId: participant.user_id,
      userName: participant.user_name || null
    })));
  }
});

RTMSManager.on('participant_video_on', ({ participants, availableParticipants, streamId }) => {
  console.log('[Consumer] Participant video on:', { streamId, participants, availableParticipants });
  trySubscribeAvailableIndividualVideo(streamId, availableParticipants);
});

RTMSManager.on('participant_video_off', ({ participants, availableParticipants, streamId }) => {
  console.log('[Consumer] Participant video off:', { streamId, participants, availableParticipants });
});

RTMSManager.on('video_on_participants_changed', ({ availableParticipants, streamId }) => {
  console.log('[Consumer] Video-on participants changed:', { streamId, availableParticipants });
  trySubscribeAvailableIndividualVideo(streamId, availableParticipants);
});

RTMSManager.on('video_subscription_response', (msg) => {
  console.log('[Consumer] Video subscription response:', msg);
  if (msg?.success === false) {
    autoSelectedVideoUserIds.delete(msg.streamId);
  }
});

RTMSManager.on('stream_state_changed', (msg) => {
  console.log('[Consumer] Stream state changed:', msg);
  if (msg?.streamId && msg?.state === 4) {
    autoSelectedVideoUserIds.delete(msg.streamId);
  }
});

RTMSManager.on('session_state_changed', (msg) => {
  console.log('[Consumer] Session state changed:', msg);
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
