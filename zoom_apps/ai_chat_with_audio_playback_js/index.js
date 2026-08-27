import { RTMSManager } from '../../library/javascript/rtmsManager/RTMSManager.js';
import WebhookManager from '../../library/javascript/webhookManager/WebhookManager.js';
import WebsocketManager from '../../library/javascript/webSocketManager/WebsocketManager.js';
import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import ejs from 'ejs';
import dotenv from 'dotenv';
import { config } from './config.js';
import { setupFrontendWss, broadcastToFrontendClients, sharedServices } from './frontendWss.js';
import { textToSpeechBase64 } from './deepgramService.js';
import { chatWithOpenRouter } from './chatWithOpenrouter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '.env') });

const { MEDIA_PARAMS } = RTMSManager;

const rtmsConfig = {
  logging: 'info',
  logDir: path.join(__dirname, 'logs'),
  mediaTypes: RTMSManager.MEDIA.TRANSCRIPT,
  credentials: {
    meeting: {
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      zoomSecretToken: config.zoomSecretToken,
    },
    websocket: {
      zoomWSURLForEvents: config.zoomWSURLForEvents,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
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

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'public'));
app.use(express.json({ verify: (req, _res, buffer) => { req.rawBody = Buffer.from(buffer); } }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.render('index', { websocket_url: config.frontendWssUrl });
});

await RTMSManager.init(rtmsConfig);

if (config.mode === 'webhook') {
  const webhookManager = new WebhookManager({
    config: {
      webhookPath: config.webhookPath,
      zoomSecretToken: config.zoomSecretToken,
    },
    app: app
  });

  webhookManager.on('event', (event, payload) => {
    console.log('[Consumer] Webhook Event:', event);
    RTMSManager.handleEvent(event, payload);
  });

  webhookManager.setup();
  console.log('Webhook Manager initialized');
} else if (config.mode === 'websocket') {
  const websocketManager = new WebsocketManager({
    config: {
      zoomWSURLForEvents: config.zoomWSURLForEvents,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
    }
  });

  websocketManager.on('event', (event, payload) => {
    console.log('[Consumer] WebSocket Event:', event);
    RTMSManager.handleEvent(event, payload);
  });

  await websocketManager.start();
  console.log('WebSocket Manager initialized');
}

sharedServices.textToSpeech = textToSpeechBase64;

setupFrontendWss(server);

RTMSManager.on('transcript', async ({ text, userId, userName, timestamp, meetingId, streamId, productType }) => {
  console.log('Transcript received:', text);
  
  try {
    const aiResponse = await chatWithOpenRouter(text);
    console.log('AI Response:', aiResponse);

    broadcastToFrontendClients({
      type: 'text',
      data: aiResponse,
      metadata: {
        source: 'transcript_response',
        originalText: text,
        userName: userName,
        timestamp: Date.now()
      }
    });

    if (sharedServices.textToSpeech) {
      const base64Audio = await sharedServices.textToSpeech(aiResponse);
      broadcastToFrontendClients({
        type: 'audio',
        data: base64Audio,
        metadata: {
          source: 'transcript_response',
          originalText: text,
          aiResponse: aiResponse,
          timestamp: Date.now()
        }
      });
    }
  } catch (error) {
    console.error('Error processing transcript:', error);
  }
});

RTMSManager.on('meeting.rtms_started', (payload) => {
  console.log(`RTMS started for meeting ${payload.meeting_uuid}`);
});

RTMSManager.on('meeting.rtms_stopped', (payload) => {
  console.log(`RTMS stopped for meeting ${payload.meeting_uuid}`);
});

await RTMSManager.start();

server.listen(config.port, () => {
  console.log(`Server running at http://localhost:${config.port}`);
  console.log(`Webhook available at http://localhost:${config.port}${config.webhookPath}`);
  console.log(`Frontend WebSocket available at ws://localhost:${config.port}/ws`);
});

process.on('SIGINT', async () => {
  console.log('Shutting down...');
  server.close();
  await RTMSManager.stop();
  process.exit(0);
});
