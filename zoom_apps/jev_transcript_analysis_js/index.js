import { RTMSManager } from '../../library/javascript/rtmsManager/RTMSManager.js';
import WebhookManager from '../../library/javascript/webhookManager/WebhookManager.js';
import { FrontendManager } from '../../library/javascript/rtmsManager/FrontendManager.js';
import { FrontendWssManager } from '../../library/javascript/rtmsManager/FrontendWssManager.js';
import { closeHttpServer, installGracefulShutdown } from '../../library/javascript/commonHelpers/gracefulShutdown.js';
import {
  analyzeSalesTurn,
  recordSalesTurn,
  updateHistorySpeakerRole,
  resetAllSalesSessions,
  resetSalesSession
} from './jevSalesAnalyzer.js';
import { SalesSessionStore } from './salesSessionStore.js';
import { createZoomContextMiddleware, createAuthorizeRegistration } from './wsAuth.js';
import express from 'express';
import http from 'http';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '.env') });

for (const name of ['ZOOM_CLIENT_ID', 'ZOOM_CLIENT_SECRET', 'ZOOM_SECRET_TOKEN', 'OPENROUTER_API_KEY']) {
  if (!process.env[name]) throw new Error(`${name} is required`);
}

const appConfig = {
  port: Number(process.env.PORT) || 3000,
  minimumTranscriptCharacters: Number(process.env.JEV_MIN_TRANSCRIPT_CHARACTERS) || 8
};

const { MEDIA_PARAMS } = RTMSManager;
const sessionStore = new SalesSessionStore();

const rtmsConfig = {
  logging: 'info',
  logDir: path.join(__dirname, 'logs'),
  mediaTypes: RTMSManager.MEDIA.TRANSCRIPT,
  credentials: {
    meeting: {
      clientId: process.env.ZOOM_CLIENT_ID,
      clientSecret: process.env.ZOOM_CLIENT_SECRET,
      zoomSecretToken: process.env.ZOOM_SECRET_TOKEN
    }
  },
  mediaParams: {
    transcript: {
      contentType: MEDIA_PARAMS.MEDIA_CONTENT_TYPE_TEXT,
      language: MEDIA_PARAMS.LANGUAGE_ID_ENGLISH
    }
  }
};

const app = express();
const server = http.createServer(app);
await RTMSManager.init(rtmsConfig);

// Block static access to EJS templates while keeping public/index.ejs as view
app.use((req, res, next) => {
  if (req.path.toLowerCase().endsWith('.ejs')) {
    return res.status(404).end();
  }
  return next();
});

// Inject verified x-zoom-app-context HMAC WS token before GET /
app.use(createZoomContextMiddleware({
  clientSecret: process.env.ZOOM_CLIENT_SECRET,
  signingSecret: process.env.ZOOM_CLIENT_SECRET || process.env.ZOOM_SECRET_TOKEN
}));

const frontendManager = new FrontendManager({
  config: {
    port: appConfig.port,
    serveStaticEnabled: true,
    viewsPath: path.join(__dirname, 'public'),
    frontendWssUrl: process.env.FRONTEND_WSS_URL_TO_CONNECT_TO || '',
    frontendWssPath: '/ws'
  },
  app
});
frontendManager.setup();

const frontendWssManager = new FrontendWssManager({
  config: { frontendWssEnabled: true, frontendWssPath: '/ws' },
  server,
  authorizeRegistration: createAuthorizeRegistration({
    getActiveConnections: () => RTMSManager.getActiveConnections(),
    signingSecret: process.env.ZOOM_CLIENT_SECRET || process.env.ZOOM_SECRET_TOKEN,
    onAuthorized: ({ meetingUUID, socket }) => {
      socket.send(JSON.stringify({
        type: 'session_snapshot',
        snapshot: sessionStore.getSnapshot(meetingUUID)
      }));
    }
  })
});
frontendWssManager.setup();

// Handle authenticated role-registration & per-speaker role toggles over WebSocket
frontendWssManager.wss?.on('connection', (ws) => {
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (!msg || msg.type === 'register' || msg.type === 'pong') return;
      if (!ws.meetingUUID || !ws.userID) return;

      if (msg.type === 'register_viewer_role') {
        const role = msg.role === 'buyer' ? 'buyer' : 'seller';
        const speakers = sessionStore.registerViewerRole(ws.meetingUUID, {
          userId: msg.userId || ws.userID,
          userName: msg.userName,
          identityIds: Array.isArray(msg.identityIds) ? msg.identityIds : [],
          role
        });
        for (const streamId of sessionStore.getStreamIds(ws.meetingUUID)) {
          updateHistorySpeakerRole(streamId, {
            userId: msg.userId || ws.userID,
            userName: msg.userName,
            role
          });
        }
        frontendWssManager.broadcastToMeeting(ws.meetingUUID, {
          type: 'roles_updated',
          speakers
        });
        return;
      }

      if (msg.type === 'set_speaker_role') {
        const role = msg.role === 'seller' ? 'seller' : 'buyer';
        const speakers = sessionStore.setSpeakerRole(ws.meetingUUID, {
          speakerKey: msg.speakerKey,
          userId: msg.userId,
          userName: msg.userName,
          role
        });
        for (const streamId of sessionStore.getStreamIds(ws.meetingUUID)) {
          updateHistorySpeakerRole(streamId, {
            userId: msg.userId,
            userName: msg.userName,
            role
          });
        }
        frontendWssManager.broadcastToMeeting(ws.meetingUUID, {
          type: 'roles_updated',
          speakers
        });
      }
    } catch (err) {
      console.warn('[JevSalesCopilot] Invalid WS action:', err.message);
    }
  });
});

const webhookManager = new WebhookManager({
  config: {
    webhookPath: process.env.WEBHOOK_PATH || '/webhook',
    zoomSecretToken: rtmsConfig.credentials.meeting.zoomSecretToken
  },
  app
});

webhookManager.on('event', (event, payload) => {
  console.log('[JevSalesCopilot] Webhook event:', event);
  RTMSManager.handleEvent(event, payload);
});
webhookManager.setup();

RTMSManager.on('transcript', async (event) => {
  try {
    const transcriptText = String(event?.text || '').trim();
    const meetingId = event?.meetingId || event?.rtmsId;
    const streamId = event?.streamId;
    if (!transcriptText || !meetingId) return;

    const { turnId, transcript, textChangedSignificantly } = sessionStore.applyTranscriptEvent(event);

    // ALWAYS record every turn (including short turns like "Yes.", "$50k", "Q3" and Seller turns)
    // into Jev's bounded dialogue history so subsequent inferences have complete context.
    recordSalesTurn({
      turnId,
      streamId,
      userId: transcript.userId,
      userName: transcript.userName,
      role: transcript.role,
      text: transcript.text,
      timestamp: transcript.timestamp
    });

    const isEligibleBuyerTurn =
      transcript.role === 'buyer' &&
      transcript.text.length >= appConfig.minimumTranscriptCharacters &&
      textChangedSignificantly;

    sessionStore.markPending(meetingId, turnId, isEligibleBuyerTurn);

    frontendWssManager.broadcastToMeeting(meetingId, {
      type: 'transcript_turn',
      meetingId,
      streamId,
      transcript,
      analysisPending: isEligibleBuyerTurn
    });

    if (!isEligibleBuyerTurn) return;

    console.log('[JevSalesCopilot] Evaluating buyer turn', {
      streamId,
      turnId,
      userId: transcript.userId,
      userName: transcript.userName,
      characters: transcript.text.length,
      revision: transcript.revision
    });

    const analysis = await analyzeSalesTurn({
      turnId,
      streamId,
      meetingId,
      userId: transcript.userId,
      userName: transcript.userName,
      role: transcript.role,
      text: transcript.text,
      timestamp: transcript.timestamp
    });

    if (analysis?.skipped) {
      sessionStore.markPending(meetingId, turnId, false);
      return;
    }

    sessionStore.recordAnalysis(meetingId, turnId, analysis, transcript.text);

    console.log('[JevSalesCopilot] Decision', {
      streamId,
      intent: analysis.buyerIntent.value,
      stage: analysis.dealStage.value,
      nextAction: analysis.nextAction.value,
      latencyMs: analysis.latencyMs
    });

    frontendWssManager.broadcastToMeeting(meetingId, {
      type: 'sales_analysis',
      turnId,
      meetingId,
      streamId,
      transcript,
      analysis
    });
  } catch (error) {
    console.error('[JevSalesCopilot] Analysis failed:', error.message);
    const meetingId = event?.meetingId || event?.rtmsId;
    if (meetingId) {
      frontendWssManager.broadcastToMeeting(meetingId, {
        type: 'analysis_error',
        turnId: event?.turnId || null,
        message: 'Sales analysis is temporarily unavailable.'
      });
    }
  }
});

RTMSManager.on('meeting.rtms_started', (payload) => {
  const meetingId = payload?.meeting_uuid;
  const streamId = payload?.rtms_stream_id;
  if (meetingId) {
    sessionStore.markRtmsStarted(meetingId, streamId);
    frontendWssManager.broadcastToMeeting(meetingId, {
      type: 'rtms_started',
      meetingId,
      streamId,
      timestamp: Date.now()
    });
  }
  console.log(`[JevSalesCopilot] RTMS started for meeting ${meetingId}`);
});

RTMSManager.on('meeting.rtms_stopped', (payload) => {
  const meetingId = payload?.meeting_uuid;
  const streamId = payload?.rtms_stream_id;
  resetSalesSession(streamId);
  if (meetingId) {
    sessionStore.markRtmsStopped(meetingId, streamId);
    frontendWssManager.broadcastToMeeting(meetingId, {
      type: 'rtms_stopped',
      meetingId,
      streamId,
      timestamp: Date.now()
    });
  }
  console.log(`[JevSalesCopilot] RTMS stopped for meeting ${meetingId}`);
});

await RTMSManager.start();
server.listen(appConfig.port, () => {
  console.log(`[JevSalesCopilot] Listening on port ${appConfig.port}`);
  console.log(`[JevSalesCopilot] Jev model: ${process.env.JEV_MODEL || 'typesafe/jev-1.13'}`);
});

installGracefulShutdown({
  name: 'Jev Sales Conversation Copilot',
  cleanup: async () => {
    sessionStore.clearAll();
    resetAllSalesSessions();
    frontendWssManager.stop();
    await closeHttpServer(server);
    await RTMSManager.stop();
  }
});
