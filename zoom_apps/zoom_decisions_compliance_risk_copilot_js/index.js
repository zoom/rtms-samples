import { RTMSManager } from '../../library/javascript/rtmsManager/RTMSManager.js';
import WebhookManager from '../../library/javascript/webhookManager/WebhookManager.js';
import { FrontendManager } from '../../library/javascript/rtmsManager/FrontendManager.js';
import { FrontendWssManager } from '../../library/javascript/rtmsManager/FrontendWssManager.js';
import { closeHttpServer, installGracefulShutdown } from '../../library/javascript/commonHelpers/gracefulShutdown.js';
import {
  analyzeComplianceTurn,
  getComplianceSessionSnapshot,
  recordComplianceTurn,
  resetAllComplianceSessions,
  resetComplianceSession,
  setSpeakerRole
} from './complianceRiskAnalyzer.js';
import {
  createRegistrationAuthorizer,
  decryptZoomAppContext,
  mintWsAuthToken
} from './wsAuth.js';
import express from 'express';
import http from 'http';
import crypto from 'crypto';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '.env') });

for (const name of ['ZOOM_CLIENT_ID', 'ZOOM_CLIENT_SECRET', 'ZOOM_SECRET_TOKEN', 'ZOOM_AI_SERVICES_API_KEY']) {
  if (!process.env[name]) throw new Error(`${name} is required`);
}

const appConfig = {
  port: Number(process.env.PORT) || 3000,
  minimumTranscriptCharacters: Number(process.env.COMPLIANCE_MIN_TRANSCRIPT_CHARACTERS) || 8,
  frontendWssAuthToken: process.env.FRONTEND_WSS_AUTH_TOKEN || '',
  allowPreRtmsRegistration: ['1', 'true', 'yes', 'on'].includes(
    String(process.env.ALLOW_PRE_RTMS_REGISTRATION || '').trim().toLowerCase()
  )
};

const wsSigningSecret = process.env.ZOOM_CLIENT_SECRET || process.env.ZOOM_SECRET_TOKEN || crypto.randomBytes(32).toString('hex');

const { MEDIA_PARAMS } = RTMSManager;
const rtmsConfig = {
  logging: 'info',
  logDir: path.join(__dirname, 'logs'),
  mediaTypes: RTMSManager.MEDIA.TRANSCRIPT,
  credentials: {
    meeting: {
      clientId: process.env.ZOOM_CLIENT_ID,
      clientSecret: process.env.ZOOM_CLIENT_SECRET,
      secretToken: process.env.ZOOM_SECRET_TOKEN
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

// Decrypt verified x-zoom-app-context on GET / to mint a short-lived HMAC WS registration token.
app.use((req, res, next) => {
  res.locals.wsAuthToken = '';
  if (req.method === 'GET' && req.path === '/') {
    const context = decryptZoomAppContext(req.headers['x-zoom-app-context'], process.env.ZOOM_CLIENT_SECRET);
    if (context) {
      res.locals.wsAuthToken = mintWsAuthToken(context, wsSigningSecret);
    }
  }
  next();
});

await RTMSManager.init(rtmsConfig);

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

const activeStreamsByMeeting = new Map();

const baseAuthorizer = createRegistrationAuthorizer({
  getActiveConnections: () => RTMSManager.getActiveConnections(),
  staticAuthToken: appConfig.frontendWssAuthToken,
  signingSecret: wsSigningSecret,
  allowPreRtmsRegistration: appConfig.allowPreRtmsRegistration
});

const frontendWssManager = new FrontendWssManager({
  config: { frontendWssEnabled: true, frontendWssPath: '/ws' },
  server,
  authorizeRegistration: async (context) => {
    const result = await baseAuthorizer(context);
    if (result.authorized && context.socket) {
      const { meetingUUID } = result;
      const ws = context.socket;

      // Late-join state/history replay right after registration succeeds.
      setImmediate(() => {
        if (ws.readyState !== 1) return;
        const streamId = activeStreamsByMeeting.get(String(meetingUUID)) || null;
        const snapshot = getComplianceSessionSnapshot({ streamId, meetingId: meetingUUID });
        ws.send(JSON.stringify({
          type: 'session_snapshot',
          meetingId: meetingUUID,
          rtmsActive: Boolean(streamId),
          ...snapshot
        }));
      });

      // Allow registered Zoom App clients to sync speaker role overrides back to Decisions prompts.
      if (!ws._copilotRoleListenerAttached) {
        ws._copilotRoleListenerAttached = true;
        ws.on('message', (raw) => {
          try {
            const msg = JSON.parse(raw.toString());
            if (msg.type === 'set_speaker_role' && ws.meetingUUID) {
              const streamId = activeStreamsByMeeting.get(String(ws.meetingUUID)) || null;
              const updatedRoles = setSpeakerRole({
                streamId,
                meetingId: ws.meetingUUID,
                userId: msg.userId,
                userName: msg.userName,
                role: msg.role
              });
              if (updatedRoles) {
                frontendWssManager.broadcastToMeeting(ws.meetingUUID, {
                  type: 'speaker_role_updated',
                  userId: msg.userId ?? null,
                  userName: msg.userName ?? null,
                  role: msg.role,
                  speakerRoles: updatedRoles
                });
              }
            }
          } catch {
            // FrontendWssManager handles invalid JSON errors.
          }
        });
      }
    }
    return result;
  }
});
frontendWssManager.setup();

const webhookManager = new WebhookManager({
  config: {
    webhookPath: process.env.WEBHOOK_PATH || '/webhook',
    zoomSecretToken: rtmsConfig.credentials.meeting.secretToken
  },
  app
});

webhookManager.on('event', (event, payload) => {
  console.log('[ComplianceRiskCopilot] Webhook event:', event);
  RTMSManager.handleEvent(event, payload);
});
webhookManager.setup();

RTMSManager.on('transcript', async ({
  text,
  userId,
  userName,
  sentenceId,
  isUpdate,
  attribute,
  startTime,
  endTime,
  timestamp,
  meetingId,
  streamId
}) => {
  const transcript = String(text || '').trim();
  if (!transcript) return;

  if (meetingId && streamId) {
    activeStreamsByMeeting.set(String(meetingId), String(streamId));
  }

  const recorded = recordComplianceTurn({
    turnId: crypto.randomUUID(),
    streamId,
    meetingId,
    userId,
    userName,
    text: transcript,
    sentenceId,
    isUpdate,
    attribute,
    startTime,
    endTime,
    timestamp,
    minimumTranscriptCharacters: appConfig.minimumTranscriptCharacters
  });
  if (!recorded) return;

  const { action, turn, shouldAnalyze, checklist } = recorded;
  console.log('[ComplianceRiskCopilot] Transcript recorded', {
    streamId,
    action,
    turnId: turn.id,
    userName: turn.userName,
    characters: turn.text.length,
    shouldAnalyze
  });

  frontendWssManager.broadcastToMeeting(meetingId, {
    type: 'transcript_turn',
    meetingId,
    streamId,
    action,
    transcript: turn,
    checklist,
    analysisPending: shouldAnalyze
  });

  if (!shouldAnalyze) return;

  try {
    const analysis = await analyzeComplianceTurn({
      turnId: turn.id,
      streamId,
      meetingId,
      userId: turn.userId,
      userName: turn.userName,
      speakerRole: turn.speakerRole,
      text: turn.text,
      timestamp: turn.timestamp,
      alreadyRecorded: true
    });

    console.log('[ComplianceRiskCopilot] Decision', {
      streamId,
      turnId: turn.id,
      stage: analysis.conversationStage.value,
      compliance: analysis.complianceState.value,
      missing: analysis.missingRequirement.value,
      nextAction: analysis.nextAction.value,
      latencyMs: analysis.latencyMs
    });

    frontendWssManager.broadcastToMeeting(meetingId, {
      type: 'compliance_analysis',
      turnId: turn.id,
      meetingId,
      streamId,
      transcript: turn,
      analysis,
      checklist: analysis.checklist
    });
  } catch (error) {
    console.error('[ComplianceRiskCopilot] Analysis failed:', error.message);
    frontendWssManager.broadcastToMeeting(meetingId, {
      type: 'analysis_error',
      turnId: turn.id,
      message: 'Compliance analysis is temporarily unavailable.'
    });
  }
});

RTMSManager.on('meeting.rtms_started', (payload) => {
  const meetingUuid = payload?.meeting_uuid;
  const streamId = payload?.rtms_stream_id || null;
  if (meetingUuid && streamId) {
    activeStreamsByMeeting.set(String(meetingUuid), String(streamId));
  }
  console.log(`[ComplianceRiskCopilot] RTMS started for meeting ${meetingUuid}`);
  if (meetingUuid) {
    frontendWssManager.broadcastToMeeting(meetingUuid, {
      type: 'rtms_started',
      meetingId: meetingUuid,
      streamId,
      timestamp: Date.now()
    });
  }
});

RTMSManager.on('meeting.rtms_stopped', (payload) => {
  const meetingUuid = payload?.meeting_uuid;
  const streamId = payload?.rtms_stream_id || null;
  resetComplianceSession(streamId);
  if (meetingUuid && activeStreamsByMeeting.get(String(meetingUuid)) === String(streamId)) {
    activeStreamsByMeeting.delete(String(meetingUuid));
  }
  console.log(`[ComplianceRiskCopilot] RTMS stopped for meeting ${meetingUuid}`);
  if (meetingUuid) {
    frontendWssManager.broadcastToMeeting(meetingUuid, {
      type: 'rtms_stopped',
      meetingId: meetingUuid,
      streamId,
      timestamp: Date.now()
    });
  }
});

server.listen(appConfig.port, () => {
  console.log(`[ComplianceRiskCopilot] Listening on port ${appConfig.port}`);
  console.log(`[ComplianceRiskCopilot] Zoom Decisions model: ${process.env.ZOOM_DECISIONS_MODEL || 'zoom-decisions'}`);
});

installGracefulShutdown({
  name: 'Compliance And Risk Copilot',
  cleanup: async () => {
    resetAllComplianceSessions();
    activeStreamsByMeeting.clear();
    frontendWssManager.stop();
    await closeHttpServer(server);
    await RTMSManager.stop();
  }
});
