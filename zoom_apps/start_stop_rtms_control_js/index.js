import { RTMSManager } from '../../library/javascript/rtmsManager/RTMSManager.js';
import WebhookManager from '../../library/javascript/webhookManager/WebhookManager.js';
import { FrontendWssManager } from '../../library/javascript/rtmsManager/FrontendWssManager.js';
import express from 'express';
import http from 'http';
import https from 'https';
import { WebSocket } from 'ws';
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
      contentType: MEDIA_PARAMS.MEDIA_CONTENT_TYPE_RAW_AUDIO,
      sampleRate: MEDIA_PARAMS.AUDIO_SAMPLE_RATE_SR_16K,
      channel: MEDIA_PARAMS.AUDIO_CHANNEL_MONO,
      codec: MEDIA_PARAMS.MEDIA_PAYLOAD_TYPE_L16,
      dataOpt: MEDIA_PARAMS.MEDIA_DATA_OPTION_AUDIO_MIXED_STREAM,
      sendRate: 100,
    },
    video: {
      contentType: MEDIA_PARAMS.MEDIA_CONTENT_TYPE_RAW_VIDEO,
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

const frontendWss = new FrontendWssManager({
  server,
  config: {
    frontendWssEnabled: true,
    frontendWssPath: '/ws'
  }
});
frontendWss.setup();

RTMSManager.on('audio', ({ buffer, userId, userName, timestamp, meetingId, streamId, productType }) => {
  console.log(`Audio received from ${userName || 'mixed'} (${buffer.length} bytes)`);
  frontendWss.broadcastToMeeting(meetingId, {
    type: 'audio',
    user: userName || 'mixed',
    userId,
    size: buffer.length,
    timestamp
  });
});

RTMSManager.on('video', ({ buffer, userId, userName, timestamp, meetingId, streamId, productType }) => {
  console.log(`Video received from ${userName} (${buffer.length} bytes)`);
  frontendWss.broadcastToMeeting(meetingId, {
    type: 'video',
    user: userName,
    userId,
    size: buffer.length,
    timestamp
  });
});

RTMSManager.on('transcript', ({ text, userId, userName, timestamp, meetingId, streamId, productType }) => {
  console.log(`Transcript from ${userName}: ${text}`);
  frontendWss.broadcastToUser(meetingId, String(userId), {
    type: 'transcript',
    user: userName,
    userId,
    content: text,
    timestamp
  });
});

RTMSManager.on('screenshare', ({ buffer, userId, userName, timestamp, meetingId, streamId, productType }) => {
  console.log(`Screen share received from ${userName} (${buffer.length} bytes)`);
  frontendWss.broadcastToMeeting(meetingId, {
    type: 'screenshare',
    user: userName,
    userId,
    size: buffer.length,
    timestamp
  });
});

RTMSManager.on('chat', ({ text, userId, userName, timestamp, meetingId, streamId, productType }) => {
  console.log(`Chat from ${userName}: ${text}`);
  frontendWss.broadcastToMeeting(meetingId, {
    type: 'chat',
    user: userName,
    userId,
    content: text,
    timestamp
  });
});

RTMSManager.on('meeting.rtms_started', (payload) => {
  console.log(`RTMS started for meeting ${payload.meeting_uuid}`);
  frontendWss.broadcastToMeeting(payload.meeting_uuid, {
    type: 'rtms_started',
    meetingUuid: payload.meeting_uuid
  });
});

RTMSManager.on('meeting.rtms_stopped', (payload) => {
  console.log(`RTMS stopped for meeting ${payload.meeting_uuid}`);
  frontendWss.broadcastToMeeting(payload.meeting_uuid, {
    type: 'rtms_stopped',
    meetingUuid: payload.meeting_uuid
  });
});

RTMSManager.on('event', ({ eventType, data, meetingId, streamId, productType }) => {
  switch (eventType) {
    case 2:
      console.log(`Active speaker changed: ${data.user_name} (${data.user_id})`);
      frontendWss.broadcastToMeeting(meetingId, {
        type: 'active_speaker',
        user: data.user_name,
        userId: data.user_id
      });
      break;
    case 3:
      if (data.participants && Array.isArray(data.participants)) {
        data.participants.forEach(p => {
          console.log(`Participant joined: ${p.user_name} (${p.user_id})`);
          frontendWss.broadcastToMeeting(meetingId, {
            type: 'participant_join',
            user: p.user_name,
            userId: p.user_id
          });
        });
      } else {
        console.log(`Participant joined: ${data.user_name} (${data.user_id})`);
        frontendWss.broadcastToMeeting(meetingId, {
          type: 'participant_join',
          user: data.user_name,
          userId: data.user_id
        });
      }
      break;
    case 4:
      if (data.participants && Array.isArray(data.participants)) {
        data.participants.forEach(p => {
          console.log(`Participant left: ${p.user_name} (${p.user_id})`);
          frontendWss.broadcastToMeeting(meetingId, {
            type: 'participant_leave',
            user: p.user_name,
            userId: p.user_id
          });
        });
      } else {
        console.log(`Participant left: ${data.user_name} (${data.user_id})`);
        frontendWss.broadcastToMeeting(meetingId, {
          type: 'participant_leave',
          user: data.user_name,
          userId: data.user_id
        });
      }
      break;
  }
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
  frontendWss.stop();
  server.close();
  await RTMSManager.stop();
  process.exit(0);
});
