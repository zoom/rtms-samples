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
import { NotetakerSessionManager } from './notetakerSessionManager.js';
import { listTemplates } from './nlp/industryExtractor.js';
import { createAuthorizeRegistration, mintTokenFromZoomAppHeader } from './wsAuth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '.env') });

const { MEDIA_PARAMS } = RTMSManager;

const appConfig = {
  port: Number(process.env.PORT) || 3000,
  webhookPath: process.env.WEBHOOK_PATH || '/webhook',
  frontendWssUrl: process.env.FRONTEND_WSS_URL_TO_CONNECT_TO || '',
  frontendWssAuthToken: process.env.FRONTEND_WSS_AUTH_TOKEN || '',
  allowPreRtmsRegistration: process.env.ALLOW_PRE_RTMS_REGISTRATION === 'true',
  defaultTemplateId: process.env.DEFAULT_INDUSTRY_TEMPLATE || 'general',
  batchSize: Number(process.env.NOTETAKER_BATCH_SIZE) || 3,
  batchDelayMs: Number(process.env.NOTETAKER_BATCH_DELAY_MS) || 4000
};

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

const signingSecret = process.env.ZOOM_SECRET_TOKEN || process.env.ZOOM_CLIENT_SECRET || '';
const authorizeMeetingAccess = createAuthorizeRegistration({
  getActiveConnections: () => RTMSManager.getActiveConnections(),
  authToken: appConfig.frontendWssAuthToken,
  signingSecret,
  allowPreRtms: appConfig.allowPreRtmsRegistration
});

const sessionManager = new NotetakerSessionManager({
  defaultTemplateId: appConfig.defaultTemplateId,
  batchSize: appConfig.batchSize,
  batchDelayMs: appConfig.batchDelayMs
});

const app = express();
const server = http.createServer(app);

// Mint short-lived WS registration token from Zoom App context header on GET /
app.use((req, res, next) => {
  if (req.method === 'GET' && req.path === '/') {
    res.locals.wsAuthToken = mintTokenFromZoomAppHeader(req.headers['x-zoom-app-context'], {
      clientSecret: process.env.ZOOM_CLIENT_SECRET,
      signingSecret
    });
  }
  next();
});

await RTMSManager.init(rtmsConfig);

const frontendManager = new FrontendManager({
  config: {
    port: appConfig.port,
    serveStaticEnabled: true,
    viewsPath: path.join(__dirname, 'views'),
    staticPath: path.join(__dirname, 'public'),
    frontendWssUrl: appConfig.frontendWssUrl,
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
  authorizeRegistration: authorizeMeetingAccess
});
frontendWssManager.setup();

const webhookManager = new WebhookManager({
  config: {
    webhookPath: appConfig.webhookPath,
    zoomSecretToken: rtmsConfig.credentials.meeting.zoomSecretToken
  },
  app
});

webhookManager.on('event', (event, payload) => {
  console.log('[Notetaker] Webhook Event:', event);
  RTMSManager.handleEvent(event, payload);
});
webhookManager.setup();

// REST API routes for template selection, manual refresh, action items, and export
const apiRouter = express.Router();
apiRouter.use(express.json());

apiRouter.get('/templates', (_req, res) => {
  res.json({ templates: listTemplates() });
});

async function authorizeApiRequest(req, res, next) {
  const meetingUUID = req.body?.meetingId || req.body?.meetingUUID || req.params?.meetingId;
  const userID = req.body?.userId || req.body?.userID || req.headers['x-user-id'] || 'api-user';
  const token = req.headers['x-ws-auth-token'] || req.body?.token || req.query?.token || '';
  const auth = await authorizeMeetingAccess({ meetingUUID, userID, token });
  if (!auth.authorized) {
    return res.status(403).json({ error: 'Unauthorized meeting access' });
  }
  req.authorizedMeetingId = auth.meetingUUID;
  return next();
}

apiRouter.post('/template', authorizeApiRequest, async (req, res) => {
  const templateId = String(req.body?.templateId || 'general');
  const state = sessionManager.setTemplate(req.authorizedMeetingId, templateId);
  frontendWssManager.broadcastToMeeting(req.authorizedMeetingId, {
    type: 'template_changed',
    state
  });
  const analyzed = await sessionManager.analyzeNow(req.authorizedMeetingId);
  if (analyzed) {
    frontendWssManager.broadcastToMeeting(req.authorizedMeetingId, {
      type: 'notes_update',
      state: analyzed
    });
  }
  return res.json({ state: analyzed || state });
});

apiRouter.post('/analyze', authorizeApiRequest, async (req, res) => {
  const state = await sessionManager.analyzeNow(req.authorizedMeetingId);
  if (state) {
    frontendWssManager.broadcastToMeeting(req.authorizedMeetingId, {
      type: 'notes_update',
      state
    });
  }
  return res.json({ state });
});

apiRouter.post('/action-items/:id/toggle', authorizeApiRequest, (req, res) => {
  const result = sessionManager.toggleActionItem(req.authorizedMeetingId, req.params.id);
  if (!result) {
    return res.status(404).json({ error: 'Action item not found' });
  }
  frontendWssManager.broadcastToMeeting(req.authorizedMeetingId, {
    type: 'action_item_updated',
    item: result.item,
    state: result.state
  });
  return res.json(result);
});

apiRouter.get('/export/:meetingId', authorizeApiRequest, (req, res) => {
  const format = String(req.query?.format || 'json').toLowerCase();
  if (format === 'md' || format === 'markdown') {
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="meeting-notes-${req.authorizedMeetingId}.md"`);
    return res.send(sessionManager.exportMarkdown(req.authorizedMeetingId));
  }
  return res.json(sessionManager.getPublicState(req.authorizedMeetingId));
});

app.use('/api', apiRouter);

// Handle interactive WS messages from registered clients
if (frontendWssManager.wss) {
  frontendWssManager.wss.on('connection', (ws) => {
    ws.on('message', async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (!msg || msg.type === 'register' || msg.type === 'pong') return;
      if (!ws.meetingUUID || !ws.userID) return;

      const meetingId = ws.meetingUUID;

      if (msg.type === 'sync_state') {
        ws.send(JSON.stringify({
          type: 'session_state',
          state: sessionManager.getPublicState(meetingId)
        }));
        return;
      }

      if (msg.type === 'set_template') {
        const state = sessionManager.setTemplate(meetingId, String(msg.templateId || 'general'));
        frontendWssManager.broadcastToMeeting(meetingId, {
          type: 'template_changed',
          state
        });
        const updated = await sessionManager.analyzeNow(meetingId);
        if (updated) {
          frontendWssManager.broadcastToMeeting(meetingId, {
            type: 'notes_update',
            state: updated
          });
        }
        return;
      }

      if (msg.type === 'analyze_now') {
        const updated = await sessionManager.analyzeNow(meetingId);
        if (updated) {
          frontendWssManager.broadcastToMeeting(meetingId, {
            type: 'notes_update',
            state: updated
          });
        }
        return;
      }

      if (msg.type === 'toggle_action_item' && msg.itemId) {
        const result = sessionManager.toggleActionItem(meetingId, String(msg.itemId));
        if (result) {
          frontendWssManager.broadcastToMeeting(meetingId, {
            type: 'action_item_updated',
            item: result.item,
            state: result.state
          });
        }
      }
    });
  });
}

RTMSManager.on('transcript', (event) => {
  const meetingId = event.meetingId || event.rtmsId;
  if (!meetingId) return;

  const { turn } = sessionManager.ingestTranscript(event, {
    onNotesUpdate: (state) => {
      frontendWssManager.broadcastToMeeting(meetingId, {
        type: 'notes_update',
        state
      });
    }
  });

  if (!turn.text) return;

  frontendWssManager.broadcastToMeeting(meetingId, {
    type: 'transcript_turn',
    meetingId,
    turn
  });
});

RTMSManager.on('meeting.rtms_started', (payload) => {
  const meetingId = payload?.meeting_uuid;
  console.log(`[Notetaker] RTMS started for meeting ${meetingId}`);
  if (meetingId) {
    const state = sessionManager.getPublicState(meetingId);
    frontendWssManager.broadcastToMeeting(meetingId, {
      type: 'rtms_status',
      status: 'started',
      state
    });
  }
});

RTMSManager.on('meeting.rtms_stopped', async (payload) => {
  const meetingId = payload?.meeting_uuid;
  console.log(`[Notetaker] RTMS stopped for meeting ${meetingId}`);
  if (meetingId) {
    try {
      const wrapupState = await sessionManager.finalizeAndCleanup(meetingId);
      frontendWssManager.broadcastToMeeting(meetingId, {
        type: 'meeting_wrapup',
        status: 'stopped',
        state: wrapupState
      });
    } catch (err) {
      console.error(`[Notetaker] Wrap-up failed for ${meetingId}:`, err.message || err);
    }
  }
});

await RTMSManager.start();

server.listen(appConfig.port, () => {
  console.log(`Server running at http://localhost:${appConfig.port}`);
  console.log(`Webhook available at http://localhost:${appConfig.port}${appConfig.webhookPath}`);
  console.log(`Frontend WebSocket available at ws://localhost:${appConfig.port}/ws`);
});

installGracefulShutdown({
  name: 'AI Notetaker',
  cleanup: async () => {
    frontendWssManager.stop();
    await closeHttpServer(server);
    await RTMSManager.stop();
  }
});
