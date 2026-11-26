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
import { DndCampaignManager } from './dndGame.js';
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
  batchDelayMs: Number(process.env.DND_TURN_BATCH_MS) || 1500
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

const campaignManager = new DndCampaignManager({
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
  console.log('[D&D] Webhook Event:', event);
  RTMSManager.handleEvent(event, payload);
});
webhookManager.setup();

function broadcastDmResult(meetingId, dmResult) {
  if (!dmResult) return;
  frontendWssManager.broadcastToMeeting(meetingId, {
    type: 'dm_response',
    meetingId,
    content: dmResult.playerText,
    user: dmResult.speaker,
    timestamp: Date.now(),
    gameresponse: {
      narration: dmResult.narration,
      scene: dmResult.scene,
      suggestedActions: dmResult.suggestedActions,
      suggestedRoll: dmResult.suggestedRoll
    },
    state: dmResult.state
  });
}

// REST endpoints for dice rolls and campaign controls (scoped and authorized per meeting)
const apiRouter = express.Router();
apiRouter.use(express.json());

async function authorizeApiRequest(req, res, next) {
  const meetingUUID = req.body?.meetingId || req.body?.meetingUUID || req.params?.meetingId;
  const userID = req.body?.userId || req.body?.userID || req.headers['x-user-id'] || 'api-user';
  const token = req.headers['x-ws-auth-token'] || req.body?.token || '';
  const auth = await authorizeMeetingAccess({ meetingUUID, userID, token });
  if (!auth.authorized) {
    return res.status(403).json({ error: 'Unauthorized meeting access' });
  }
  req.authorizedMeetingId = auth.meetingUUID;
  req.authorizedUserId = auth.userID;
  return next();
}

apiRouter.post('/dice', authorizeApiRequest, async (req, res) => {
  try {
    const result = await campaignManager.rollDice(req.authorizedMeetingId, {
      playerName: req.body?.playerName,
      userId: req.authorizedUserId,
      formula: req.body?.formula || '1d20',
      modifier: Number(req.body?.modifier) || 0,
      skill: req.body?.skill || '',
      dc: req.body?.dc ?? null,
      narrate: req.body?.narrate !== false
    });
    frontendWssManager.broadcastToMeeting(req.authorizedMeetingId, {
      type: 'dice_result',
      roll: result.roll,
      state: result.state
    });
    if (result.dmResult) {
      broadcastDmResult(req.authorizedMeetingId, result.dmResult);
    }
    return res.json(result);
  } catch (err) {
    return res.status(400).json({ error: err.message || 'Invalid dice roll' });
  }
});

apiRouter.post('/campaign/ooc', authorizeApiRequest, (req, res) => {
  const state = campaignManager.setInCharacter(req.authorizedMeetingId, Boolean(req.body?.inCharacter));
  frontendWssManager.broadcastToMeeting(req.authorizedMeetingId, {
    type: 'campaign_state',
    state
  });
  return res.json({ state });
});

apiRouter.post('/campaign/reset', authorizeApiRequest, (req, res) => {
  const state = campaignManager.resetCampaign(req.authorizedMeetingId);
  frontendWssManager.broadcastToMeeting(req.authorizedMeetingId, {
    type: 'campaign_state',
    state
  });
  return res.json({ state });
});

app.use('/api', apiRouter);

// Handle interactive WS messages from registered meeting clients
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
        if (msg.playerName) {
          campaignManager.ensurePartyMember(meetingId, {
            userId: ws.userID,
            userName: String(msg.playerName).slice(0, 60)
          });
        }
        const state = campaignManager.getPublicState(meetingId);
        ws.send(JSON.stringify({ type: 'campaign_state', state }));
        if (msg.playerName) {
          frontendWssManager.broadcastToMeeting(meetingId, { type: 'campaign_state', state });
        }
        return;
      }

      if (msg.type === 'toggle_ooc') {
        const state = campaignManager.setInCharacter(meetingId, Boolean(msg.inCharacter));
        frontendWssManager.broadcastToMeeting(meetingId, { type: 'campaign_state', state });
        return;
      }

      if (msg.type === 'reset_campaign') {
        const state = campaignManager.resetCampaign(meetingId);
        frontendWssManager.broadcastToMeeting(meetingId, { type: 'campaign_state', state });
        return;
      }

      if (msg.type === 'player_action') {
        const text = String(msg.text || '').trim();
        if (!text) return;
        const dmResult = await campaignManager.submitPlayerAction(meetingId, {
          userId: ws.userID,
          playerName: msg.playerName || `User ${ws.userID}`,
          text
        });
        broadcastDmResult(meetingId, dmResult);
        return;
      }

      if (msg.type === 'dice_roll') {
        try {
          const result = await campaignManager.rollDice(meetingId, {
            userId: ws.userID,
            playerName: msg.playerName || `User ${ws.userID}`,
            formula: msg.formula || '1d20',
            modifier: Number(msg.modifier) || 0,
            skill: msg.skill || '',
            dc: msg.dc ?? null,
            narrate: msg.narrate !== false
          });
          frontendWssManager.broadcastToMeeting(meetingId, {
            type: 'dice_result',
            roll: result.roll,
            state: result.state
          });
          if (result.dmResult) {
            broadcastDmResult(meetingId, result.dmResult);
          }
        } catch (err) {
          ws.send(JSON.stringify({ type: 'error', message: err.message || 'Invalid dice formula' }));
        }
      }
    });
  });
}

RTMSManager.on('transcript', (event) => {
  const meetingId = event.meetingId || event.rtmsId;
  if (!meetingId) return;

  const { transcriptTurn, state } = campaignManager.ingestTranscript(event, {
    onDmResponse: (dmResult) => broadcastDmResult(meetingId, dmResult)
  });

  if (!transcriptTurn.text) return;

  frontendWssManager.broadcastToMeeting(meetingId, {
    type: 'transcript_turn',
    meetingId,
    transcript: transcriptTurn,
    party: state.party
  });
});

RTMSManager.on('meeting.rtms_started', (payload) => {
  const meetingId = payload?.meeting_uuid;
  console.log(`[D&D] RTMS started for meeting ${meetingId}`);
  if (meetingId) {
    const state = campaignManager.getPublicState(meetingId);
    frontendWssManager.broadcastToMeeting(meetingId, {
      type: 'rtms_status',
      status: 'started',
      state
    });
  }
});

RTMSManager.on('meeting.rtms_stopped', (payload) => {
  const meetingId = payload?.meeting_uuid;
  console.log(`[D&D] RTMS stopped for meeting ${meetingId}`);
  if (meetingId) {
    frontendWssManager.broadcastToMeeting(meetingId, {
      type: 'rtms_status',
      status: 'stopped'
    });
    campaignManager.clearCampaign(meetingId);
  }
});

await RTMSManager.start();

server.listen(appConfig.port, () => {
  console.log(`Server running at http://localhost:${appConfig.port}`);
  console.log(`Webhook available at http://localhost:${appConfig.port}${appConfig.webhookPath}`);
  console.log(`Frontend WebSocket available at ws://localhost:${appConfig.port}/ws`);
});

installGracefulShutdown({
  name: 'AI DND',
  cleanup: async () => {
    frontendWssManager.stop();
    await closeHttpServer(server);
    await RTMSManager.stop();
  }
});
