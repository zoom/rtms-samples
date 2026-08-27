import { RTMSManager } from '../../library/javascript/rtmsManager/RTMSManager.js';
import {
  buildUrlValidationResponse,
  captureRawBody,
  verifyZoomWebhookRequest
} from '../../library/javascript/webhookManager/zoomWebhookSignature.js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import { closeHttpServer, installGracefulShutdown } from '../../library/javascript/commonHelpers/gracefulShutdown.js';
import http from 'http';

import { chatWithTranscript, clearOpenAIStream, openAIConfig } from './chatWithOpenAI.js';
import { sanitizeProviderError } from '../../library/javascript/commonHelpers/providerRequestControls.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '.env'), quiet: true });

const { MEDIA_PARAMS } = RTMSManager;

const appConfig = {
  port: process.env.PORT || 3000,
  webhookPath: process.env.WEBHOOK_PATH || '/webhook'
};

const rtmsConfig = {
  logging: {
    enabled: true,
    logDir: path.join(__dirname, 'logs'),
    console: true
  },
  mediaSocketConnectionMode: process.env.MEDIA_SOCKET_CONNECTION_MODE || 'split',
  mediaTypes: RTMSManager.MEDIA.TRANSCRIPT,
  credentials: {
    meeting: {
      clientId: process.env.ZOOM_CLIENT_ID,
      clientSecret: process.env.ZOOM_CLIENT_SECRET,
      zoomSecretToken: process.env.ZOOM_SECRET_TOKEN,
    }
  },
  mediaParams: {
    transcript: {
      contentType: MEDIA_PARAMS.MEDIA_CONTENT_TYPE_TEXT,
      language: MEDIA_PARAMS.LANGUAGE_ID_ENGLISH,
    }
  }
};

console.log('[send_to_openai] App Configuration:', appConfig);
console.log('[send_to_openai] Provider Configuration:', { ...openAIConfig, apiKey: '[REDACTED]' });
console.log('[send_to_openai] RTMS Configuration:', RTMSManager.redactSecrets(rtmsConfig));

const app = express();
const server = http.createServer(app);

await RTMSManager.init(rtmsConfig);

app.use(appConfig.webhookPath, express.json({ verify: captureRawBody, limit: '1mb' }));
app.post(appConfig.webhookPath, (req, res) => {
  const { event, payload } = req.body || {};
  if (event === 'endpoint.url_validation' && payload?.plainToken) {
    if (!process.env.ZOOM_SECRET_TOKEN) return res.status(500).json({ error: 'webhook_secret_not_configured' });
    return res.json(buildUrlValidationResponse(payload.plainToken, process.env.ZOOM_SECRET_TOKEN));
  }

  const verification = verifyZoomWebhookRequest(req, process.env.ZOOM_SECRET_TOKEN, {
    toleranceSeconds: process.env.WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS
  });
  if (!verification.ok) {
    const status = verification.reason === 'missing_webhook_secret_token' ? 500 : 401;
    return res.status(status).json({ error: 'invalid_zoom_webhook' });
  }

  if (typeof event !== 'string' || !payload || typeof payload !== 'object') {
    return res.status(400).json({ error: 'invalid_webhook_payload' });
  }

  res.once('finish', () => {
    setImmediate(() => {
      try {
        console.log('[send_to_openai] Verified webhook event:', event);
        RTMSManager.handleEvent(event, payload);
      } catch (error) {
        console.error('[send_to_openai] Deferred webhook processing failed:', error.message);
      }
    });
  });
  res.status(200).end();
});

RTMSManager.on('transcript', async ({ text, userName, streamId }) => {
  console.log(`[TRANSCRIPT] ${userName}: ${text}`);
  
  try {
    const response = await chatWithTranscript(text, streamId);
    console.log('[OpenAI Response]:', response);
  } catch (error) {
    console.error('[OpenAI Error]', sanitizeProviderError('OpenAI', error));
  }
});

RTMSManager.on('meeting.rtms_started', (payload) => {
  console.log('[send_to_openai] RTMS Started:', payload.meeting_uuid);
});

RTMSManager.on('meeting.rtms_stopped', (payload) => {
  console.log('[send_to_openai] RTMS Stopped:', payload.meeting_uuid);
  clearOpenAIStream(payload.rtms_stream_id);
});

await RTMSManager.start();

server.listen(appConfig.port, () => {
  console.log(`[send_to_openai] Server listening on port ${appConfig.port}`);
  console.log(`[send_to_openai] Webhook endpoint: http://localhost:${appConfig.port}${appConfig.webhookPath}`);
});

installGracefulShutdown({ name: 'send_to_openai', cleanup: async () => {
  await closeHttpServer(server);
  await RTMSManager.stop();
} });
