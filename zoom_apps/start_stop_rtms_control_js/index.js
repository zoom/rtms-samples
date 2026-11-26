import { RTMSManager } from '../../library/javascript/rtmsManager/RTMSManager.js';
import { TranscriptRevisionStore } from '../../library/javascript/rtmsManager/utils/TranscriptRevisionStore.js';
import WebhookManager from '../../library/javascript/webhookManager/WebhookManager.js';
import WebsocketManager from '../../library/javascript/webSocketManager/WebsocketManager.js';
import { FrontendManager } from '../../library/javascript/rtmsManager/FrontendManager.js';
import { FrontendWssManager } from '../../library/javascript/rtmsManager/FrontendWssManager.js';
import { closeHttpServer, installGracefulShutdown } from '../../library/javascript/commonHelpers/gracefulShutdown.js';
import {
  MeetingTelemetryTracker,
  createRegistrationAuthorizer,
  decryptZoomAppContext,
  mintWsAuthToken
} from './rtmsControlHelpers.js';
import express from 'express';
import http from 'http';
import crypto from 'crypto';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '.env') });

const { MEDIA_PARAMS } = RTMSManager;

const config = {
  port: Number(process.env.PORT) || 3000,
  mode: (process.env.MODE || 'webhook').trim().toLowerCase(),
  webhookPath: process.env.WEBHOOK_PATH || '/webhook',
  zoomWSURLForEvents: process.env.zoomWSURLForEvents || '',
  clientId: process.env.ZOOM_CLIENT_ID || '',
  clientSecret: process.env.ZOOM_CLIENT_SECRET || '',
  secretToken: process.env.ZOOM_SECRET_TOKEN || '',
  frontendWssUrl: process.env.WS_URL || process.env.FRONTEND_WSS_URL || '',
  frontendWssAuthToken: process.env.FRONTEND_WSS_AUTH_TOKEN || '',
  allowPreRtmsRegistration: ['1', 'true', 'yes', 'on'].includes(
    String(process.env.ALLOW_PRE_RTMS_REGISTRATION || '').trim().toLowerCase()
  )
};

const wsSigningSecret = config.clientSecret || config.secretToken || crypto.randomBytes(32).toString('hex');

const rtmsConfig = {
  logging: 'info',
  logDir: path.join(__dirname, 'logs'),
  mediaTypes:
    RTMSManager.MEDIA.AUDIO |
    RTMSManager.MEDIA.VIDEO |
    RTMSManager.MEDIA.SHARESCREEN |
    RTMSManager.MEDIA.TRANSCRIPT |
    RTMSManager.MEDIA.CHAT,
  credentials: {
    meeting: {
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      secretToken: config.secretToken,
    },
  },
  mediaParams: {
    audio: {
      contentType: MEDIA_PARAMS.MEDIA_CONTENT_TYPE_RAW_AUDIO,
      sampleRate: MEDIA_PARAMS.AUDIO_SAMPLE_RATE_SR_16K,
      channel: MEDIA_PARAMS.AUDIO_CHANNEL_MONO,
      codec: MEDIA_PARAMS.MEDIA_PAYLOAD_TYPE_L16,
      dataOpt: MEDIA_PARAMS.MEDIA_DATA_OPTION_AUDIO_MIXED_STREAM,
      sendRate: 100,
    },
    video: {
      contentType: MEDIA_PARAMS.MEDIA_CONTENT_TYPE_RAW_VIDEO,
      codec: MEDIA_PARAMS.MEDIA_PAYLOAD_TYPE_H264,
      resolution: MEDIA_PARAMS.MEDIA_RESOLUTION_HD,
      dataOpt: MEDIA_PARAMS.MEDIA_DATA_OPTION_VIDEO_SINGLE_ACTIVE_STREAM,
      fps: 25,
    },
    transcript: {
      contentType: MEDIA_PARAMS.MEDIA_CONTENT_TYPE_TEXT,
      language: MEDIA_PARAMS.LANGUAGE_ID_ENGLISH,
    },
  }
};

const app = express();
const server = http.createServer(app);

// Mint a short-lived HMAC token when Zoom delivers a verified x-zoom-app-context header.
app.use((req, res, next) => {
  res.locals.wsAuthToken = '';
  if (req.method === 'GET' && req.path === '/') {
    const contextHeader = req.headers['x-zoom-app-context'];
    const context = decryptZoomAppContext(contextHeader, config.clientSecret);
    if (context) {
      res.locals.wsAuthToken = mintWsAuthToken(context, wsSigningSecret);
    }
  }
  next();
});

const frontendManager = new FrontendManager({
  config: {
    port: config.port,
    serveStaticEnabled: true,
    viewsPath: path.join(__dirname, 'views'),
    staticPath: path.join(__dirname, 'public'),
    frontendWssUrl: config.frontendWssUrl,
    frontendWssPath: '/ws'
  },
  app
});
frontendManager.setup();

await RTMSManager.init(rtmsConfig);

const transcriptStore = new TranscriptRevisionStore();
const telemetryTracker = new MeetingTelemetryTracker();
const streamToMeeting = new Map();

const baseAuthorize = createRegistrationAuthorizer({
  getActiveConnections: () => RTMSManager.getActiveConnections(),
  staticAuthToken: config.frontendWssAuthToken,
  signingSecret: wsSigningSecret,
  allowPreRtmsRegistration: config.allowPreRtmsRegistration
});

const frontendWss = new FrontendWssManager({
  server,
  config: {
    frontendWssEnabled: true,
    frontendWssPath: '/ws'
  },
  authorizeRegistration: async (context) => {
    const result = await baseAuthorize(context);
    if (result.authorized && context.socket) {
      const { meetingUUID } = result;
      setImmediate(() => {
        if (context.socket.readyState !== 1) return;
        const snapshot = telemetryTracker.getSnapshot(meetingUUID);
        if (snapshot) {
          context.socket.send(JSON.stringify(snapshot));
        }
        const sentences = transcriptStore.sentences().filter((s) => String(s.rtmsId || '') === String(meetingUUID));
        if (sentences.length > 0) {
          context.socket.send(JSON.stringify({
            type: 'transcript_history',
            meetingUuid: meetingUUID,
            items: sentences.slice(-50).map((sentence) => ({
              key: `${sentence.streamId}:${sentence.channelId ?? sentence.userId ?? null}:${sentence.sentenceId ?? `#${sentence.order}`}`,
              sentenceId: sentence.sentenceId,
              revision: sentence.revision,
              user: sentence.userName || `User ${sentence.userId ?? 'unknown'}`,
              userId: sentence.userId,
              content: sentence.text,
              timestamp: sentence.timestamp || Date.now()
            }))
          }));
        }
      });
    }
    return result;
  }
});
frontendWss.setup();

const telemetryTimer = setInterval(() => {
  const snapshots = telemetryTracker.flushInterval();
  for (const snapshot of snapshots) {
    frontendWss.broadcastToMeeting(snapshot.meetingUuid, snapshot);
  }
}, 1000);
telemetryTimer.unref?.();

RTMSManager.on('audio', ({ buffer, userName, timestamp, meetingId, streamId }) => {
  telemetryTracker.recordMedia(meetingId, 'audio', {
    bytes: buffer?.length || 0,
    userName: userName || 'mixed',
    timestamp,
    streamId
  });
});

RTMSManager.on('video', ({ buffer, userName, timestamp, meetingId, streamId }) => {
  telemetryTracker.recordMedia(meetingId, 'video', {
    bytes: buffer?.length || 0,
    userName: userName || 'active-speaker',
    timestamp,
    streamId
  });
});

RTMSManager.on('screenshare', ({ buffer, userName, timestamp, meetingId, streamId }) => {
  telemetryTracker.recordMedia(meetingId, 'screenshare', {
    bytes: buffer?.length || 0,
    userName: userName || 'presenter',
    timestamp,
    streamId
  });
});

RTMSManager.on('transcript', ({
  text,
  userId,
  userName,
  sentenceId,
  isUpdate,
  attribute,
  language,
  startTime,
  endTime,
  timestamp,
  meetingId,
  streamId
}) => {
  const content = String(text ?? '').trim();
  if (!content) return;

  const displayName = userName || `User ${userId ?? 'unknown'}`;
  const { action, key, sentence } = transcriptStore.apply({
    streamId,
    rtmsId: meetingId,
    meetingId,
    userId,
    userName: displayName,
    sentenceId,
    isUpdate,
    attribute,
    language,
    startTime,
    endTime,
    text: content,
    timestamp: timestamp || Date.now()
  });

  telemetryTracker.recordMedia(meetingId, 'transcript', {
    bytes: Buffer.byteLength(content, 'utf8'),
    userName: displayName,
    timestamp: sentence.timestamp,
    streamId
  });

  frontendWss.broadcastToMeeting(meetingId, {
    type: 'transcript',
    action,
    key,
    sentenceId: sentence.sentenceId,
    revision: sentence.revision,
    isUpdate: action === 'updated' || action === 'replaced',
    user: sentence.userName || displayName,
    userId: sentence.userId,
    content: sentence.text,
    timestamp: sentence.timestamp || Date.now(),
    streamId,
    meetingId
  });
});

RTMSManager.on('chat', ({ text, userId, userName, sender, timestamp, meetingId, streamId }) => {
  const content = String(text ?? '').trim();
  if (!content) return;

  const displayName = userName ?? sender?.userName ?? sender?.user_name ?? `User ${userId ?? 'unknown'}`;
  telemetryTracker.recordMedia(meetingId, 'chat', {
    bytes: Buffer.byteLength(content, 'utf8'),
    userName: displayName,
    timestamp,
    streamId
  });

  frontendWss.broadcastToMeeting(meetingId, {
    type: 'chat',
    user: displayName,
    userId,
    content,
    timestamp: timestamp || Date.now(),
    streamId,
    meetingId
  });
});

RTMSManager.on('meeting.rtms_started', (payload) => {
  const meetingUuid = payload?.meeting_uuid;
  const streamId = payload?.rtms_stream_id || null;
  if (!meetingUuid) return;

  console.log(`[RTMSControl] RTMS started for meeting ${meetingUuid}`);
  if (streamId) streamToMeeting.set(String(streamId), String(meetingUuid));
  telemetryTracker.markStarted(meetingUuid, streamId);

  frontendWss.broadcastToMeeting(meetingUuid, {
    type: 'rtms_started',
    meetingUuid,
    streamId,
    timestamp: Date.now()
  });
});

RTMSManager.on('meeting.rtms_stopped', (payload) => {
  const streamId = payload?.rtms_stream_id || null;
  const meetingUuid = payload?.meeting_uuid || (streamId ? streamToMeeting.get(String(streamId)) : null);
  if (streamId) {
    transcriptStore.clear(streamId);
    streamToMeeting.delete(String(streamId));
  }
  if (!meetingUuid) return;

  console.log(`[RTMSControl] RTMS stopped for meeting ${meetingUuid}`);
  telemetryTracker.markStopped(meetingUuid, streamId);

  frontendWss.broadcastToMeeting(meetingUuid, {
    type: 'rtms_stopped',
    meetingUuid,
    streamId,
    stopReason: payload?.stop_reason ?? null,
    timestamp: Date.now()
  });
});

RTMSManager.on('event', ({ eventCode, data = {}, meetingId }) => {
  if (!meetingId) return;
  switch (eventCode) {
    case RTMSManager.EVENT_CODES.ACTIVE_SPEAKER_CHANGE: {
      const user = data.user_name || `User ${data.user_id ?? 'unknown'}`;
      telemetryTracker.setActiveSpeaker(meetingId, { userId: data.user_id, userName: user });
      frontendWss.broadcastToMeeting(meetingId, {
        type: 'active_speaker',
        user,
        userId: data.user_id,
        timestamp: Date.now()
      });
      break;
    }
    case RTMSManager.EVENT_CODES.PARTICIPANT_JOIN: {
      const list = Array.isArray(data.participants) ? data.participants : [data];
      telemetryTracker.addParticipants(meetingId, list);
      for (const p of list) {
        if (p?.user_id == null && !p?.user_name) continue;
        frontendWss.broadcastToMeeting(meetingId, {
          type: 'participant_join',
          user: p.user_name || `User ${p.user_id ?? 'unknown'}`,
          userId: p.user_id,
          timestamp: Date.now()
        });
      }
      break;
    }
    case RTMSManager.EVENT_CODES.PARTICIPANT_LEAVE: {
      const list = Array.isArray(data.participants) ? data.participants : [data];
      telemetryTracker.removeParticipants(meetingId, list);
      for (const p of list) {
        if (p?.user_id == null && !p?.user_name) continue;
        frontendWss.broadcastToMeeting(meetingId, {
          type: 'participant_leave',
          user: p.user_name || `User ${p.user_id ?? 'unknown'}`,
          userId: p.user_id,
          timestamp: Date.now()
        });
      }
      break;
    }
  }
});

let eventWsManager = null;

if (config.mode === 'webhook') {
  console.log('[RTMSControl] Running in webhook mode');
  const webhookManager = new WebhookManager({
    config: {
      webhookPath: config.webhookPath,
      zoomSecretToken: config.secretToken,
    },
    app
  });

  webhookManager.on('event', (event, payload) => {
    console.log('[Webhook] Event received:', event);
    RTMSManager.handleEvent(event, payload);
  });

  webhookManager.setup();
} else if (config.mode === 'websocket') {
  console.log('[RTMSControl] Running in WebSocket event mode');
  if (!config.zoomWSURLForEvents || !config.clientId || !config.clientSecret) {
    console.error('Missing required env vars: zoomWSURLForEvents, ZOOM_CLIENT_ID, or ZOOM_CLIENT_SECRET');
    process.exit(1);
  }

  eventWsManager = new WebsocketManager({
    config: {
      zoomWSURLForEvents: config.zoomWSURLForEvents,
      clientId: config.clientId,
      clientSecret: config.clientSecret
    }
  });
  eventWsManager.on('event', (event, payload) => {
    console.log('[EventWS] Event received:', event);
    RTMSManager.handleEvent(event, payload);
  });
  await eventWsManager.start();
} else {
  console.error(`[RTMSControl] Unsupported MODE "${config.mode}". Expected "webhook" or "websocket".`);
  process.exit(1);
}

server.listen(config.port, () => {
  console.log(`[RTMSControl] Server running at http://localhost:${config.port}`);
  if (config.mode === 'webhook') {
    console.log(`[RTMSControl] Webhook available at http://localhost:${config.port}${config.webhookPath}`);
  }
  console.log(`[RTMSControl] Frontend WebSocket available at ws://localhost:${config.port}/ws`);
});

installGracefulShutdown({
  name: 'RTMS Control',
  cleanup: async () => {
    clearInterval(telemetryTimer);
    if (eventWsManager) eventWsManager.stop();
    transcriptStore.clear();
    telemetryTracker.clear();
    frontendWss.stop();
    await closeHttpServer(server);
    await RTMSManager.stop();
  }
});
