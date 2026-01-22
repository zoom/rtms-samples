import { RTMSManager } from '../../library/javascript/rtmsManager/RTMSManager.js';
import WebhookManager from '../../library/javascript/webhookManager/WebhookManager.js';
import express from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import ejs from 'ejs';
import { extractAndAccumulateTraits } from './chatWithOpenrouterForTraits.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '.env') });

const { MEDIA_PARAMS } = RTMSManager;

const appConfig = {
  port: process.env.PORT || 3000,
};

const rtmsConfig = {
  logging: 'info',
  logDir: path.join(__dirname, 'logs'),
  credentials: {
    meeting: {
      clientId: process.env.ZOOM_CLIENT_ID,
      clientSecret: process.env.ZOOM_CLIENT_SECRET,
      zoomSecretToken: process.env.ZOOM_SECRET_TOKEN,
    },
  },
  mediaParams: {
    audio: {
      contentType: MEDIA_PARAMS.MEDIA_CONTENT_TYPE_RTP,
      sampleRate: MEDIA_PARAMS.AUDIO_SAMPLE_RATE_SR_16K,
      channel: MEDIA_PARAMS.AUDIO_CHANNEL_MONO,
      codec: MEDIA_PARAMS.MEDIA_PAYLOAD_TYPE_L16,
      dataOpt: MEDIA_PARAMS.MEDIA_DATA_OPTION_AUDIO_MIXED_STREAM,
      sendRate: 100,
    },
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
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.render('index', { websocket_url: process.env.WS_URL });
});

app.get('/home', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'home.html'));
});

await RTMSManager.init(rtmsConfig);

const webhookManager = new WebhookManager({
  config: {
    webhookPath: process.env.WEBHOOK_PATH || '/',
    zoomSecretToken: rtmsConfig.credentials.meeting.zoomSecretToken,
  },
  app: app
});

webhookManager.on('event', (event, payload) => {
  console.log('[Consumer] Webhook Event:', event);
  RTMSManager.handleEvent(event, payload);
});

webhookManager.setup();

const frontendClients = new Set();
const frontendWss = new WebSocketServer({ server, path: '/ws' });

frontendWss.on('connection', (ws) => {
  frontendClients.add(ws);
  console.log('Frontend client connected');
  ws.send('Connected to RTMS backend');

  ws.on('close', () => {
    frontendClients.delete(ws);
    console.log('Frontend client disconnected');
  });

  ws.on('error', (err) => {
    frontendClients.delete(ws);
    console.error('WebSocket error:', err);
  });
});

function broadcastToFrontendClients(message) {
  const json = typeof message === 'string' ? message : JSON.stringify(message);
  for (const client of frontendClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(json);
    }
  }
}

RTMSManager.on('transcript', async ({ text, userId, userName, timestamp, meetingId, streamId, productType }) => {
  console.log('Transcript received:', text);
  
  const { current: traitsCount, total } = await extractAndAccumulateTraits(text);

  console.log("Trait Counts (this message):", traitsCount);
  console.log("Accumulated Trait Totals:", total);

  broadcastToFrontendClients({
    type: 'transcript',
    content: text,
    user: userName,
    timestamp: Date.now(),
    traits: total
  });
});

RTMSManager.on('meeting.rtms_started', (payload) => {
  console.log(`RTMS started for meeting ${payload.meeting_uuid}`);
});

RTMSManager.on('meeting.rtms_stopped', (payload) => {
  console.log(`RTMS stopped for meeting ${payload.meeting_uuid}`);
});

await RTMSManager.start();

server.listen(appConfig.port, () => {
  console.log(`Server running at http://localhost:${appConfig.port}`);
  console.log(`Frontend WebSocket available at ws://localhost:${appConfig.port}/ws`);
});

process.on('SIGINT', async () => {
  console.log('Shutting down...');
  server.close();
  await RTMSManager.stop();
  process.exit(0);
});
