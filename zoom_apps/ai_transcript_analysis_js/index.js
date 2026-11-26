import { RTMSManager } from '../../library/javascript/rtmsManager/RTMSManager.js';
import WebhookManager from '../../library/javascript/webhookManager/WebhookManager.js';
import { FrontendManager } from '../../library/javascript/rtmsManager/FrontendManager.js';
import { FrontendWssManager } from '../../library/javascript/rtmsManager/FrontendWssManager.js';
import { closeHttpServer, installGracefulShutdown } from '../../library/javascript/commonHelpers/gracefulShutdown.js';
import express from 'express';
import http from 'http';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

import { MeetingTraitTracker } from './chatWithOpenrouterForTraits.js';
import { createZoomContextMiddleware, createAuthorizeRegistration } from './wsAuth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '.env') });

const { MEDIA_PARAMS } = RTMSManager;
const traitTracker = new MeetingTraitTracker();

const appConfig = {
  port: Number(process.env.PORT) || 3000,
};

const rtmsConfig = {
  logging: 'info',
  logDir: path.join(__dirname, 'logs'),
  mediaTypes: RTMSManager.MEDIA.TRANSCRIPT,
  credentials: {
    meeting: {
      clientId: process.env.ZOOM_CLIENT_ID,
      clientSecret: process.env.ZOOM_CLIENT_SECRET,
      zoomSecretToken: process.env.ZOOM_SECRET_TOKEN,
    },
  },
  mediaParams: {
    transcript: {
      contentType: MEDIA_PARAMS.MEDIA_CONTENT_TYPE_TEXT,
      language: MEDIA_PARAMS.LANGUAGE_ID_ENGLISH,
    },
  }
};

const app = express();
const server = http.createServer(app);

await RTMSManager.init(rtmsConfig);

// Verify x-zoom-app-context header and inject short-lived wsAuthToken before GET /
app.use(createZoomContextMiddleware({
  clientSecret: process.env.ZOOM_CLIENT_SECRET,
  signingSecret: process.env.ZOOM_CLIENT_SECRET || process.env.ZOOM_SECRET_TOKEN
}));

const frontendManager = new FrontendManager({
  config: {
    port: appConfig.port,
    serveStaticEnabled: true,
    viewsPath: path.join(__dirname, 'views'),
    staticPath: path.join(__dirname, 'public'),
    frontendWssUrl: process.env.FRONTEND_WSS_URL_TO_CONNECT_TO || '',
    frontendWssPath: '/ws'
  },
  app
});
frontendManager.setup();

const frontendWssManager = new FrontendWssManager({
  config: {
    frontendWssEnabled: true,
    frontendWssPath: '/ws'
  },
  server,
  authorizeRegistration: createAuthorizeRegistration({
    getActiveConnections: () => RTMSManager.getActiveConnections(),
    signingSecret: process.env.ZOOM_CLIENT_SECRET || process.env.ZOOM_SECRET_TOKEN,
    onAuthorized: ({ meetingUUID, socket }) => {
      socket.send(JSON.stringify({
        type: 'session_snapshot',
        snapshot: traitTracker.getSnapshot(meetingUUID)
      }));
    }
  })
});
frontendWssManager.setup();

const webhookManager = new WebhookManager({
  config: {
    webhookPath: process.env.WEBHOOK_PATH || '/webhook',
    zoomSecretToken: rtmsConfig.credentials.meeting.zoomSecretToken,
  },
  app
});

webhookManager.on('event', (event, payload) => {
  console.log('[Traits] Webhook Event:', event);
  RTMSManager.handleEvent(event, payload);
});

webhookManager.setup();

RTMSManager.on('transcript', async (event) => {
  try {
    const text = String(event?.text || '').trim();
    const meetingId = event?.meetingId || event?.rtmsId;
    if (!text || !meetingId) return;

    const { utterance } = traitTracker.ingestTranscript(event, (update) => {
      frontendWssManager.broadcastToMeeting(meetingId, {
        type: 'traits_update',
        ...update
      });
    });

    // Immediately show transcript turn while trait analysis runs asynchronously
    frontendWssManager.broadcastToMeeting(meetingId, {
      type: 'transcript',
      utterance
    });
  } catch (err) {
    console.error('[Traits] Transcript handler error:', err.message);
  }
});

RTMSManager.on('meeting.rtms_started', (payload) => {
  const meetingId = payload?.meeting_uuid;
  const streamId = payload?.rtms_stream_id;
  if (meetingId) {
    traitTracker.markRtmsStarted(meetingId, streamId);
    frontendWssManager.broadcastToMeeting(meetingId, {
      type: 'rtms_started',
      meetingId,
      streamId,
      timestamp: Date.now()
    });
  }
  console.log(`[Traits] RTMS started for meeting ${meetingId}`);
});

RTMSManager.on('meeting.rtms_stopped', (payload) => {
  const meetingId = payload?.meeting_uuid;
  const streamId = payload?.rtms_stream_id;
  if (meetingId) {
    traitTracker.clearMeeting(meetingId, streamId);
    frontendWssManager.broadcastToMeeting(meetingId, {
      type: 'rtms_stopped',
      meetingId,
      streamId,
      timestamp: Date.now()
    });
  }
  console.log(`[Traits] RTMS stopped for meeting ${meetingId}`);
});

await RTMSManager.start();

server.listen(appConfig.port, () => {
  console.log(`[Traits] Server running at http://localhost:${appConfig.port}`);
  console.log(`[Traits] Frontend WebSocket available at ws://localhost:${appConfig.port}/ws`);
});

installGracefulShutdown({
  name: 'AI Transcript Analysis',
  cleanup: async () => {
    traitTracker.clearAll();
    frontendWssManager.stop();
    await closeHttpServer(server);
    await RTMSManager.stop();
  }
});
