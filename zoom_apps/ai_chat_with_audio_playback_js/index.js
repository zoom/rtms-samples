import { RTMSManager } from '../../library/javascript/rtmsManager/RTMSManager.js';
import WebhookManager from '../../library/javascript/webhookManager/WebhookManager.js';
import WebsocketManager from '../../library/javascript/webSocketManager/WebsocketManager.js';
import { FrontendManager } from '../../library/javascript/rtmsManager/FrontendManager.js';
import { FrontendWssManager } from '../../library/javascript/rtmsManager/FrontendWssManager.js';
import { closeHttpServer, installGracefulShutdown } from '../../library/javascript/commonHelpers/gracefulShutdown.js';
import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { loadConfig } from './config.js';
import { textToSpeechBase64 } from './deepgramService.js';
import { chatWithOpenRouter } from './chatWithOpenrouter.js';
import { ChatSessionManager } from './chatSessionManager.js';
import { createAuthorizeRegistration, mintTokenFromZoomAppHeader } from './wsAuth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '.env') });

const config = loadConfig(process.env, { validate: true });
const { MEDIA_PARAMS } = RTMSManager;

const sessionManager = new ChatSessionManager({
  defaultMode: config.defaultResponseMode,
  defaultWakeWords: config.defaultWakeWords,
  echoCooldownMs: config.echoCooldownMs,
  echoWindowMs: config.echoWindowMs,
  maxHistoryMessages: config.maxHistoryMessages
});

const rtmsConfig = {
  logging: 'info',
  logDir: path.join(__dirname, 'logs'),
  mediaTypes: RTMSManager.MEDIA.TRANSCRIPT,
  credentials: {
    meeting: {
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      zoomSecretToken: config.zoomSecretToken
    },
    websocket: {
      zoomWSURLForEvents: config.zoomWSURLForEvents,
      clientId: config.clientId,
      clientSecret: config.clientSecret
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

// Prevent raw EJS templates inside public/ from being served statically
app.use((req, res, next) => {
  if (req.path.toLowerCase().endsWith('.ejs')) {
    return res.status(404).end();
  }
  return next();
});

// Mint short-lived WS registration token from decrypted Zoom App context on GET /
app.use((req, res, next) => {
  if (req.method === 'GET' && req.path === '/') {
    res.locals.wsAuthToken = mintTokenFromZoomAppHeader(req.headers['x-zoom-app-context'], {
      clientSecret: config.clientSecret,
      signingSecret: config.zoomSecretToken || config.clientSecret
    });
  }
  next();
});

await RTMSManager.init(rtmsConfig);

const frontendManager = new FrontendManager({
  config: {
    port: config.port,
    serveStaticEnabled: true,
    viewsPath: path.join(__dirname, 'public'),
    staticPath: path.join(__dirname, 'public'),
    frontendWssUrl: config.frontendWssUrl,
    frontendWssPath: '/ws'
  },
  app
});
frontendManager.setup();

const frontendWssManager = new FrontendWssManager({
  config: {
    frontendWssEnabled: true,
    frontendWssPath: '/ws',
    frontendWssMaxPayloadBytes: 256 * 1024
  },
  server,
  authorizeRegistration: createAuthorizeRegistration({
    getActiveConnections: () => RTMSManager.getActiveConnections(),
    authToken: config.frontendWssAuthToken,
    signingSecret: config.zoomSecretToken || config.clientSecret,
    allowPreRtms: config.allowPreRtmsRegistration
  })
});
frontendWssManager.setup();

async function generateAndBroadcastReply(meetingId, { source, originalText, speaker }) {
  const { epoch, signal, messages } = sessionManager.beginReplyTurn(meetingId);

  frontendWssManager.broadcastToMeeting(meetingId, {
    type: 'assistant_status',
    status: 'thinking',
    timestamp: Date.now()
  });

  try {
    const aiResponse = await chatWithOpenRouter(messages, { signal });
    if (!sessionManager.isTurnCurrent(meetingId, epoch)) {
      return;
    }

    const estimatedAudioMs = Math.min(Math.max(aiResponse.length * 65, 1800), 10000);
    const replyItem = sessionManager.recordAssistantReply(meetingId, aiResponse, {
      estimatedAudioMs
    });

    frontendWssManager.broadcastToMeeting(meetingId, {
      type: 'text',
      data: aiResponse,
      metadata: {
        replyId: replyItem.id,
        source,
        originalText,
        userName: speaker,
        timestamp: replyItem.timestamp
      }
    });

    if (process.env.DEEPGRAM_API_KEY) {
      try {
        const base64Audio = await textToSpeechBase64(aiResponse, {
          container: 'wav',
          encoding: 'linear16',
          sample_rate: 24000
        });
        if (!sessionManager.isTurnCurrent(meetingId, epoch)) {
          return;
        }
        frontendWssManager.broadcastToMeeting(meetingId, {
          type: 'audio',
          data: base64Audio,
          metadata: {
            replyId: replyItem.id,
            source,
            format: 'wav',
            sampleRate: 24000,
            originalText,
            aiResponse,
            timestamp: Date.now()
          }
        });
      } catch (ttsError) {
        console.error('[AI Chat] Deepgram TTS error:', ttsError.message || ttsError);
        frontendWssManager.broadcastToMeeting(meetingId, {
          type: 'assistant_status',
          status: 'tts_unavailable',
          message: 'Text reply delivered; audio synthesis failed.',
          timestamp: Date.now()
        });
      }
    }
  } catch (error) {
    if (error?.name === 'AbortError') {
      return;
    }
    console.error('[AI Chat] Error generating AI response:', error.message || error);
    frontendWssManager.broadcastToMeeting(meetingId, {
      type: 'error',
      message: 'Sorry, I encountered an error generating a response. Please try again.'
    });
  } finally {
    if (sessionManager.isTurnCurrent(meetingId, epoch)) {
      frontendWssManager.broadcastToMeeting(meetingId, {
        type: 'assistant_status',
        status: 'idle',
        timestamp: Date.now()
      });
    }
  }
}

// Handle application-level WS messages from registered meeting clients
if (frontendWssManager.wss) {
  frontendWssManager.wss.on('connection', (ws) => {
    ws.on('message', async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (!msg || msg.type === 'register' || msg.type === 'pong') {
        return;
      }

      // Fail closed: require registration before handling any interactive message
      if (!ws.meetingUUID || !ws.userID) {
        return;
      }

      const meetingId = ws.meetingUUID;

      if (msg.type === 'sync_state') {
        ws.send(JSON.stringify({
          type: 'session_state',
          state: sessionManager.getPublicState(meetingId)
        }));
        return;
      }

      if (msg.type === 'settings') {
        const updated = sessionManager.updateSettings(meetingId, msg.settings || msg);
        frontendWssManager.broadcastToMeeting(meetingId, {
          type: 'settings_updated',
          state: updated
        });
        return;
      }

      if (msg.type === 'interrupt') {
        sessionManager.interrupt(meetingId);
        frontendWssManager.broadcastToMeeting(meetingId, {
          type: 'interrupted',
          byUserID: ws.userID,
          timestamp: Date.now()
        });
        return;
      }

      if (msg.type === 'text') {
        const text = String(msg.data || '').trim();
        if (!text) return;
        const speaker = String(msg.speaker || `User ${ws.userID}`).slice(0, 80);
        const turn = sessionManager.handleTypedMessage(meetingId, { text, speaker });
        if (!turn) return;

        frontendWssManager.broadcastToMeeting(meetingId, {
          type: 'user_message',
          message: turn.logItem
        });

        await generateAndBroadcastReply(meetingId, {
          source: 'typed_message',
          originalText: turn.promptText,
          speaker: turn.speaker
        });
      }
    });
  });
}

let websocketManager = null;

if (config.mode === 'webhook') {
  const webhookManager = new WebhookManager({
    config: {
      webhookPath: config.webhookPath,
      zoomSecretToken: config.zoomSecretToken
    },
    app
  });

  webhookManager.on('event', (event, payload) => {
    console.log('[AI Chat] Webhook Event:', event);
    RTMSManager.handleEvent(event, payload);
  });

  webhookManager.setup();
} else if (config.mode === 'websocket') {
  websocketManager = new WebsocketManager({
    config: {
      zoomWSURLForEvents: config.zoomWSURLForEvents,
      clientId: config.clientId,
      clientSecret: config.clientSecret
    }
  });

  websocketManager.on('event', (event, payload) => {
    console.log('[AI Chat] WebSocket Event:', event);
    RTMSManager.handleEvent(event, payload);
  });

  await websocketManager.start();
}

RTMSManager.on('transcript', async (event) => {
  const meetingId = event.meetingId || event.rtmsId;
  if (!meetingId) return;

  const result = sessionManager.handleTranscriptEvent(event);
  if (!result.logItem?.text) return;

  frontendWssManager.broadcastToMeeting(meetingId, {
    type: 'transcript',
    action: result.revision.action,
    sentenceKey: result.revision.key,
    message: result.logItem,
    suppressedReason: result.suppressedReason,
    willReply: result.shouldReply
  });

  if (result.shouldReply) {
    // Push-to-talk disarms automatically; broadcast updated settings
    frontendWssManager.broadcastToMeeting(meetingId, {
      type: 'settings_updated',
      state: sessionManager.getPublicState(meetingId)
    });

    await generateAndBroadcastReply(meetingId, {
      source: 'transcript_response',
      originalText: result.promptText,
      speaker: result.speaker
    });
  }
});

RTMSManager.on('meeting.rtms_started', (payload) => {
  const meetingId = payload?.meeting_uuid;
  console.log(`[AI Chat] RTMS started for meeting ${meetingId}`);
  if (meetingId) {
    sessionManager.getOrCreateSession(meetingId);
    frontendWssManager.broadcastToMeeting(meetingId, {
      type: 'rtms_status',
      status: 'started',
      timestamp: Date.now()
    });
  }
});

RTMSManager.on('meeting.rtms_stopped', (payload) => {
  const meetingId = payload?.meeting_uuid;
  console.log(`[AI Chat] RTMS stopped for meeting ${meetingId}`);
  if (meetingId) {
    frontendWssManager.broadcastToMeeting(meetingId, {
      type: 'rtms_status',
      status: 'stopped',
      timestamp: Date.now()
    });
    sessionManager.clearSession(meetingId);
  }
});

await RTMSManager.start();

server.listen(config.port, () => {
  console.log(`Server running at http://localhost:${config.port}`);
  console.log(`Webhook available at http://localhost:${config.port}${config.webhookPath}`);
  console.log(`Frontend WebSocket available at ws://localhost:${config.port}/ws`);
});

installGracefulShutdown({
  name: 'AI Chat',
  cleanup: async () => {
    frontendWssManager.stop();
    if (websocketManager && typeof websocketManager.stop === 'function') {
      await websocketManager.stop();
    }
    await closeHttpServer(server);
    await RTMSManager.stop();
  }
});
