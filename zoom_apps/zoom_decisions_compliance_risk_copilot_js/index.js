import { RTMSManager } from '../../library/javascript/rtmsManager/RTMSManager.js';
import WebhookManager from '../../library/javascript/webhookManager/WebhookManager.js';
import { FrontendManager } from '../../library/javascript/rtmsManager/FrontendManager.js';
import { FrontendWssManager } from '../../library/javascript/rtmsManager/FrontendWssManager.js';
import { closeHttpServer, installGracefulShutdown } from '../../library/javascript/commonHelpers/gracefulShutdown.js';
import { analyzeComplianceTurn, resetAllComplianceSessions, resetComplianceSession } from './complianceRiskAnalyzer.js';
import express from 'express';
import http from 'http';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '.env') });

for (const name of ['ZOOM_CLIENT_ID', 'ZOOM_CLIENT_SECRET', 'ZOOM_SECRET_TOKEN', 'ZOOM_AI_SERVICES_API_KEY']) {
  if (!process.env[name]) throw new Error(`${name} is required`);
}

const appConfig = {
  port: Number(process.env.PORT) || 3000,
  minimumTranscriptCharacters: Number(process.env.COMPLIANCE_MIN_TRANSCRIPT_CHARACTERS) || 8
};

const { MEDIA_PARAMS } = RTMSManager;
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
  authorizeRegistration: async ({ meetingUUID, userID }) => {
    const authorized = RTMSManager.getActiveConnections().some((connection) =>
      String(connection.meetingUuid || connection.rtmsId || '') === String(meetingUUID)
    );
    return authorized ? { authorized: true, meetingUUID, userID } : { authorized: false };
  }
});
frontendWssManager.setup();

const webhookManager = new WebhookManager({
  config: {
    webhookPath: process.env.WEBHOOK_PATH || '/webhook',
    zoomSecretToken: rtmsConfig.credentials.meeting.zoomSecretToken
  },
  app
});

webhookManager.on('event', (event, payload) => {
  console.log('[ComplianceRiskCopilot] Webhook event:', event);
  RTMSManager.handleEvent(event, payload);
});
webhookManager.setup();

RTMSManager.on('transcript', async ({ text, userId, userName, timestamp, meetingId, streamId }) => {
  const transcript = String(text || '').trim();
  if (!transcript) return;
  console.log('[ComplianceRiskCopilot] Transcript event received', { streamId, userId, userName, characters: transcript.length });
  const turnId = randomUUID();
  const transcriptTurn = {
    id: turnId,
    text: transcript,
    userId,
    userName: userName || `User ${userId || 'unknown'}`,
    timestamp: Number(timestamp) || Date.now()
  };

  frontendWssManager.broadcastToMeeting(meetingId, {
    type: 'transcript_turn',
    meetingId,
    streamId,
    transcript: transcriptTurn,
    analysisPending: transcript.length >= appConfig.minimumTranscriptCharacters
  });

  if (transcript.length < appConfig.minimumTranscriptCharacters) return;

  console.log('[ComplianceRiskCopilot] Transcript received', {
    streamId,
    userId,
    userName,
    characters: transcript.length
  });

  try {
    const analysis = await analyzeComplianceTurn({
      turnId,
      streamId,
      meetingId,
      userId,
      userName,
      text: transcript,
      timestamp
    });

    console.log('[ComplianceRiskCopilot] Decision', {
      streamId,
      stage: analysis.conversationStage.value,
      compliance: analysis.complianceState.value,
      missing: analysis.missingRequirement.value,
      nextAction: analysis.nextAction.value,
      latencyMs: analysis.latencyMs
    });

    frontendWssManager.broadcastToMeeting(meetingId, {
      type: 'compliance_analysis',
      turnId,
      meetingId,
      streamId,
      transcript: transcriptTurn,
      analysis
    });
  } catch (error) {
    console.error('[ComplianceRiskCopilot] Analysis failed:', error.message);
    frontendWssManager.broadcastToMeeting(meetingId, {
      type: 'analysis_error',
      turnId,
      message: 'Compliance analysis is temporarily unavailable.'
    });
  }
});

RTMSManager.on('meeting.rtms_started', (payload) => {
  console.log(`[ComplianceRiskCopilot] RTMS started for meeting ${payload.meeting_uuid}`);
});

RTMSManager.on('meeting.rtms_stopped', (payload) => {
  resetComplianceSession(payload.rtms_stream_id);
  console.log(`[ComplianceRiskCopilot] RTMS stopped for meeting ${payload.meeting_uuid}`);
});

await RTMSManager.start();
server.listen(appConfig.port, () => {
  console.log(`[ComplianceRiskCopilot] Listening on port ${appConfig.port}`);
  console.log(`[ComplianceRiskCopilot] Zoom Decisions model: ${process.env.ZOOM_DECISIONS_MODEL || 'zoom-decisions'}`);
});

installGracefulShutdown({
  name: 'Compliance And Risk Copilot',
  cleanup: async () => {
    resetAllComplianceSessions();
    frontendWssManager.stop();
    await closeHttpServer(server);
    await RTMSManager.stop();
  }
});
