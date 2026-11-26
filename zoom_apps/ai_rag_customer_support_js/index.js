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

import {
  preloadRetrieverOnce,
  reloadKnowledgeBase,
  getKnowledgeBaseStatus,
  askLLMWithTranscript,
  shouldTriggerAutoRag
} from './ragPipeline.js';
import { SupportSessionStore } from './supportSessionStore.js';
import { createZoomContextMiddleware, createAuthorizeRegistration } from './wsAuth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '.env') });

await preloadRetrieverOnce();

const { MEDIA_PARAMS } = RTMSManager;
const sessionStore = new SupportSessionStore();

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

// Inject verified Zoom App context WS token before FrontendManager registers GET /
app.use(createZoomContextMiddleware({
  clientSecret: process.env.ZOOM_CLIENT_SECRET,
  signingSecret: process.env.ZOOM_CLIENT_SECRET || process.env.ZOOM_SECRET_TOKEN
}));

// Parse JSON ONLY on /api so WebhookManager preserves rawBody on WEBHOOK_PATH
app.use('/api', express.json({ limit: '64kb' }));

app.get('/api/kb', (_req, res) => {
  res.json(getKnowledgeBaseStatus());
});

app.post('/api/kb/reload', async (_req, res) => {
  try {
    const status = await reloadKnowledgeBase();
    frontendWssManager.broadcastToFrontendClients({
      type: 'kb_status',
      ...status
    });
    res.json(status);
  } catch (err) {
    console.error('[RAG] Failed to reload KB:', err.message);
    res.status(500).json({ error: 'Failed to reload knowledge base' });
  }
});

app.post('/api/search', async (req, res) => {
  const query = String(req.body?.query || '').trim();
  const meetingId = req.body?.meetingId ? String(req.body.meetingId) : null;
  if (!query) {
    return res.status(400).json({ error: 'query is required' });
  }

  try {
    const recentContext = meetingId ? sessionStore.getRecentContext(meetingId, 6) : [];
    const result = await askLLMWithTranscript(query, { conversationContext: recentContext });
    const card = meetingId
      ? sessionStore.addSuggestion(meetingId, {
          ...result,
          sourceType: 'manual',
          speaker: 'Agent Search'
        })
      : { ...result, sourceType: 'manual', speaker: 'Agent Search', createdAt: Date.now() };

    if (meetingId) {
      frontendWssManager.broadcastToMeeting(meetingId, {
        type: 'rag_suggestion',
        suggestion: card
      });
    }
    res.json({ suggestion: card });
  } catch (err) {
    console.error('[RAG] Manual search failed:', err.message);
    res.status(500).json({ error: 'Knowledge base search failed' });
  }
});

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
        snapshot: sessionStore.getSnapshot(meetingUUID),
        kb: getKnowledgeBaseStatus()
      }));
    }
  })
});
frontendWssManager.setup();

// Handle authenticated client actions over WebSocket (role mapping, manual search, KB reload)
frontendWssManager.wss?.on('connection', (ws) => {
  ws.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (!msg || msg.type === 'register' || msg.type === 'pong') return;
      if (!ws.meetingUUID || !ws.userID) return;

      if (msg.type === 'register_agent_identity') {
        const speakers = sessionStore.registerAgentIdentity(ws.meetingUUID, {
          userId: msg.userId || ws.userID,
          userName: msg.userName,
          identityIds: Array.isArray(msg.identityIds) ? msg.identityIds : []
        });
        frontendWssManager.broadcastToMeeting(ws.meetingUUID, {
          type: 'roles_updated',
          speakers
        });
        return;
      }

      if (msg.type === 'set_speaker_role') {
        const speakers = sessionStore.setSpeakerRole(ws.meetingUUID, {
          speakerKey: msg.speakerKey,
          userId: msg.userId,
          userName: msg.userName,
          role: msg.role
        });
        frontendWssManager.broadcastToMeeting(ws.meetingUUID, {
          type: 'roles_updated',
          speakers
        });
        return;
      }

      if (msg.type === 'manual_search') {
        const query = String(msg.query || '').trim();
        if (!query) return;
        const recentContext = sessionStore.getRecentContext(ws.meetingUUID, 6);
        const result = await askLLMWithTranscript(query, { conversationContext: recentContext });
        const card = sessionStore.addSuggestion(ws.meetingUUID, {
          ...result,
          sourceType: 'manual',
          speaker: msg.speaker || 'Agent Search'
        });
        frontendWssManager.broadcastToMeeting(ws.meetingUUID, {
          type: 'rag_suggestion',
          suggestion: card
        });
        return;
      }

      if (msg.type === 'reload_kb') {
        const status = await reloadKnowledgeBase();
        frontendWssManager.broadcastToMeeting(ws.meetingUUID, {
          type: 'kb_status',
          ...status
        });
      }
    } catch (err) {
      console.error('[RAG] WS action error:', err.message);
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'action_error', message: err.message }));
      }
    }
  });
});

const webhookManager = new WebhookManager({
  config: {
    webhookPath: process.env.WEBHOOK_PATH || '/webhook',
    zoomSecretToken: rtmsConfig.credentials.meeting.zoomSecretToken,
  },
  app
});

webhookManager.on('event', (event, payload) => {
  console.log('[RAG] Webhook Event:', event);
  RTMSManager.handleEvent(event, payload);
});

webhookManager.setup();

RTMSManager.on('transcript', async (event) => {
  try {
    const text = String(event?.text || '').trim();
    const meetingId = event?.meetingId || event?.rtmsId;
    if (!text || !meetingId) return;

    const { turn, textChangedSignificantly, recentContext } = sessionStore.applyTranscriptEvent(event);

    frontendWssManager.broadcastToMeeting(meetingId, {
      type: 'transcript',
      turn,
      speakers: sessionStore.getSpeakers(meetingId)
    });

    // Only auto-trigger RAG on substantive customer questions/intent
    if (turn.role !== 'customer') return;
    if (!textChangedSignificantly) return;
    if (!shouldTriggerAutoRag(turn.text)) return;

    sessionStore.markSentenceAnalyzed(meetingId, turn.sentenceKey, turn.text);
    frontendWssManager.broadcastToMeeting(meetingId, {
      type: 'rag_pending',
      sentenceKey: turn.sentenceKey,
      question: turn.text,
      speaker: turn.userName
    });

    const result = await askLLMWithTranscript(turn.text, {
      conversationContext: recentContext
    });

    const card = sessionStore.addSuggestion(meetingId, {
      ...result,
      sentenceKey: turn.sentenceKey,
      sourceType: 'auto',
      speaker: turn.userName,
      userId: turn.userId
    });

    frontendWssManager.broadcastToMeeting(meetingId, {
      type: 'rag_suggestion',
      suggestion: card
    });
  } catch (err) {
    console.error('[RAG] Transcript handler error:', err.message);
    const meetingId = event?.meetingId || event?.rtmsId;
    if (meetingId) {
      frontendWssManager.broadcastToMeeting(meetingId, {
        type: 'action_error',
        message: 'Knowledge base lookup temporarily unavailable.'
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
  console.log(`[RAG] RTMS started for meeting ${meetingId}`);
});

RTMSManager.on('meeting.rtms_stopped', (payload) => {
  const meetingId = payload?.meeting_uuid;
  const streamId = payload?.rtms_stream_id;
  if (meetingId) {
    sessionStore.markRtmsStopped(meetingId, streamId);
    frontendWssManager.broadcastToMeeting(meetingId, {
      type: 'rtms_stopped',
      meetingId,
      streamId,
      timestamp: Date.now()
    });
  }
  console.log(`[RAG] RTMS stopped for meeting ${meetingId}`);
});

await RTMSManager.start();

server.listen(appConfig.port, () => {
  console.log(`[RAG] Server running at http://localhost:${appConfig.port}`);
  console.log(`[RAG] Frontend WebSocket available at ws://localhost:${appConfig.port}/ws`);
});

installGracefulShutdown({
  name: 'AI RAG Customer Support',
  cleanup: async () => {
    sessionStore.clearAll();
    frontendWssManager.stop();
    await closeHttpServer(server);
    await RTMSManager.stop();
  }
});
