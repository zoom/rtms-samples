import { RTMSManager } from '../../library/javascript/rtmsManager/RTMSManager.js';
import WebhookManager from '../../library/javascript/webhookManager/WebhookManager.js';
import express from 'express';
import http from 'http';
import https from 'https';
import { WebSocketServer, WebSocket } from 'ws';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '.env') });

const { MEDIA_PARAMS } = RTMSManager;

const config = {
  port: process.env.PORT || 3000,
  mode: process.env.MODE || 'webhook',
  webhookPath: process.env.WEBHOOK_PATH || '/webhook',
  zoomWSURLForEvents: process.env.zoomWSURLForEvents || '',
  clientId: process.env.ZOOM_CLIENT_ID,
  clientSecret: process.env.ZOOM_CLIENT_SECRET,
  zoomSecretToken: process.env.ZOOM_SECRET_TOKEN,
  wsUrl: process.env.WS_URL || 'wss://yoururl.ngrok.com/ws',
  s2sClientId: process.env.ZOOM_S2S_CLIENT_ID || null,
  s2sClientSecret: process.env.ZOOM_S2S_CLIENT_SECRET || null,
  accountId: process.env.ZOOM_ACCOUNT_ID || null,
};

const rtmsConfig = {
  logging: 'info',
  logDir: path.join(__dirname, 'logs'),
  credentials: {
    meeting: {
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      zoomSecretToken: config.zoomSecretToken,
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
    video: {
      codec: MEDIA_PARAMS.VIDEO_CODEC_H264,
      resolution: MEDIA_PARAMS.VIDEO_RESOLUTION_720P,
      dataOpt: MEDIA_PARAMS.MEDIA_DATA_OPTION_VIDEO_SINGLE_ACTIVE_STREAM,
      fps: 25,
    },
    transcript: {
      contentType: MEDIA_PARAMS.MEDIA_CONTENT_TYPE_TEXT,
      language: MEDIA_PARAMS.LANGUAGE_ID_ENGLISH,
    },
  }
};

const app = express();
const server = http.createServer(app);

app.use(express.json());
app.set('view engine', 'ejs');
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.render('index', { websocketUrl: config.wsUrl });
});

await RTMSManager.init(rtmsConfig);

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

RTMSManager.on('audio', ({ buffer, userId, userName, timestamp, meetingId, streamId, productType }) => {
  console.log(`Audio received from ${userName || 'mixed'} (${buffer.length} bytes)`);
  broadcastToFrontendClients({
    type: 'audio',
    user: userName || 'mixed',
    size: buffer.length,
    timestamp
  });
});

RTMSManager.on('video', ({ buffer, userId, userName, timestamp, meetingId, streamId, productType }) => {
  console.log(`Video received from ${userName} (${buffer.length} bytes)`);
  broadcastToFrontendClients({
    type: 'video',
    user: userName,
    size: buffer.length,
    timestamp
  });
});

RTMSManager.on('transcript', ({ text, userId, userName, timestamp, meetingId, streamId, productType }) => {
  console.log(`Transcript from ${userName}: ${text}`);
  broadcastToFrontendClients({
    type: 'transcript',
    user: userName,
    content: text,
    timestamp
  });
});

RTMSManager.on('screenshare', ({ buffer, userId, userName, timestamp, meetingId, streamId, productType }) => {
  console.log(`Screen share received from ${userName} (${buffer.length} bytes)`);
  broadcastToFrontendClients({
    type: 'screenshare',
    user: userName,
    size: buffer.length,
    timestamp
  });
});

RTMSManager.on('chat', ({ text, userId, userName, timestamp, meetingId, streamId, productType }) => {
  console.log(`Chat from ${userName}: ${text}`);
  broadcastToFrontendClients({
    type: 'chat',
    user: userName,
    content: text,
    timestamp
  });
});

RTMSManager.on('meeting.rtms_started', (payload) => {
  console.log(`RTMS started for meeting ${payload.meeting_uuid}`);
  broadcastToFrontendClients({
    type: 'rtms_started',
    meetingUuid: payload.meeting_uuid
  });
});

RTMSManager.on('meeting.rtms_stopped', (payload) => {
  console.log(`RTMS stopped for meeting ${payload.meeting_uuid}`);
  broadcastToFrontendClients({
    type: 'rtms_stopped',
    meetingUuid: payload.meeting_uuid
  });
});

RTMSManager.on('participantJoin', ({ userId, userName, meetingId }) => {
  console.log(`Participant joined: ${userName} (${userId})`);
  broadcastToFrontendClients({
    type: 'participant_join',
    user: userName,
    userId
  });
});

RTMSManager.on('participantLeave', ({ userId, userName, meetingId }) => {
  console.log(`Participant left: ${userName} (${userId})`);
  broadcastToFrontendClients({
    type: 'participant_leave',
    user: userName,
    userId
  });
});

RTMSManager.on('activeSpeakerChange', ({ userId, userName, meetingId }) => {
  console.log(`Active speaker changed: ${userName} (${userId})`);
  broadcastToFrontendClients({
    type: 'active_speaker',
    user: userName,
    userId
  });
});

if (config.mode === 'webhook') {
  console.log('Running in webhook mode');
  
  const webhookManager = new WebhookManager({
    config: {
      webhookPath: config.webhookPath,
      zoomSecretToken: config.zoomSecretToken,
    },
    app: app
  });

  webhookManager.on('event', (event, payload) => {
    console.log('[Webhook] Event received:', event);
    RTMSManager.handleEvent(event, payload);
  });

  webhookManager.setup();
  
} else if (config.mode === 'websocket') {
  console.log('Running in WebSocket event mode');
  
  if (!config.zoomWSURLForEvents || !config.clientId || !config.clientSecret) {
    console.error('Missing required env vars: zoomWSURLForEvents, ZOOM_CLIENT_ID, or ZOOM_CLIENT_SECRET');
    process.exit(1);
  }

  const accessToken = await new Promise((resolve) => {
    const credentials = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');
    const options = {
      method: 'POST',
      hostname: 'zoom.us',
      path: '/oauth/token?grant_type=client_credentials',
      headers: {
        'Authorization': `Basic ${credentials}`
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          const tokenData = JSON.parse(body);
          console.log('Zoom access token received');
          resolve(tokenData.access_token);
        } else {
          console.error(`Zoom token request failed: ${res.statusCode} ${body}`);
          resolve(null);
        }
      });
    });

    req.on('error', (err) => {
      console.error('HTTPS error requesting token:', err.message);
      resolve(null);
    });

    req.end();
  });

  if (!accessToken) {
    console.error('Failed to get access token');
    process.exit(1);
  }

  const fullWsUrl = `${config.zoomWSURLForEvents}&access_token=${accessToken}`;
  console.log('Connecting to Zoom Events WebSocket...');
  
  const eventWs = new WebSocket(fullWsUrl);

  eventWs.on('open', () => {
    console.log('Connected to Zoom Events WebSocket');
    eventWs.send(JSON.stringify({ module: 'heartbeat' }));
    console.log('Sent initial heartbeat');

    setInterval(() => {
      if (eventWs.readyState === WebSocket.OPEN) {
        eventWs.send(JSON.stringify({ module: 'heartbeat' }));
        console.log('Heartbeat sent');
      }
    }, 30000);
  });

  eventWs.on('message', async (message) => {
    console.log('Received message from Zoom Event WebSocket');

    try {
      const msg = JSON.parse(message.toString());
      if (msg.module === 'message' && msg.content) {
        const eventData = JSON.parse(msg.content);
        const event = eventData.event;
        const payload = eventData.payload || {};

        console.log(`Parsed Event: ${event}`);
        RTMSManager.handleEvent(event, payload);
      }
    } catch (err) {
      console.error('Error processing message:', err.message);
    }
  });

  eventWs.on('error', (err) => {
    console.error(`WebSocket Error: ${err.message}`);
  });

  eventWs.on('close', (code, reason) => {
    console.warn(`WebSocket closed | Code: ${code}, Reason: ${reason}`);
  });
}

await RTMSManager.start();

server.listen(config.port, () => {
  console.log(`Server running at http://localhost:${config.port}`);
  if (config.mode === 'webhook') {
    console.log(`Webhook available at http://localhost:${config.port}${config.webhookPath}`);
  }
  console.log(`Frontend WebSocket available at ws://localhost:${config.port}/ws`);
});

process.on('SIGINT', async () => {
  console.log('Shutting down...');
  server.close();
  await RTMSManager.stop();
  process.exit(0);
});
