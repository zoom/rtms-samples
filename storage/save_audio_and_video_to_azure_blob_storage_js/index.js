import { RTMSManager } from '../../library/javascript/rtmsManager/RTMSManager.js';
import WebhookManager from '../../library/javascript/webhookManager/WebhookManager.js';
import WebsocketManager from '../../library/javascript/webSocketManager/WebsocketManager.js';
import HelperManager, { VideoGapFiller } from '../../library/javascript/commonHelpers/HelperManager.js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import http from 'http';

import { saveToAzure } from './AzureStorageHelper.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '.env') });

const { MEDIA_PARAMS } = RTMSManager;

const appConfig = {
  port: process.env.PORT || 3000,
  managerType: process.env.RTMSTRIGGERMANAGERTYPE || 'webhook',
};

const s2sCredentials = {
  clientId: process.env.ZOOM_S2S_CLIENT_ID || null,
  clientSecret: process.env.ZOOM_S2S_CLIENT_SECRET || null,
  accountId: process.env.ZOOM_ACCOUNT_ID || null,
};

const websocketCredentials = {
  zoomWSURLForEvents: process.env.zoomWSURLForEvents || '',
  clientId: process.env.ZOOM_CLIENT_ID,
  clientSecret: process.env.ZOOM_CLIENT_SECRET,
};

const rtmsConfig = {
  logging: process.env.LOG_LEVEL || 'info',
  logDir: path.join(__dirname, 'logs'),
  mediaSocketConnectionMode: process.env.MEDIA_SOCKET_CONNECTION_MODE || 'split',
  mediaTypesFlag: parseInt(process.env.MEDIA_TYPES_FLAG || '3'),
  credentials: {
    meeting: {
      clientId: process.env.ZOOM_CLIENT_ID,
      clientSecret: process.env.ZOOM_CLIENT_SECRET,
      zoomSecretToken: process.env.ZOOM_SECRET_TOKEN,
    },
    video: {
      videoClientId: process.env.VIDEO_CLIENT_ID,
      videoClientSecret: process.env.VIDEO_CLIENT_SECRET,
      videoSecretToken: process.env.VIDEO_SECRET_TOKEN,
    },
    s2s: s2sCredentials,
    websocket: websocketCredentials
  },
  mediaParams: {
    audio: {
      contentType: MEDIA_PARAMS.MEDIA_CONTENT_TYPE_RTP,
      sampleRate: MEDIA_PARAMS.AUDIO_SAMPLE_RATE_SR_16K,
      channel: MEDIA_PARAMS.AUDIO_CHANNEL_MONO,
      codec: MEDIA_PARAMS.MEDIA_PAYLOAD_TYPE_L16,
      dataOpt: MEDIA_PARAMS.MEDIA_DATA_OPTION_AUDIO_MIXED_STREAM,
      sendRate: 20,
    },
    video: {
      codec: MEDIA_PARAMS.MEDIA_PAYLOAD_TYPE_H264,
      dataOpt: MEDIA_PARAMS.MEDIA_DATA_OPTION_VIDEO_SINGLE_ACTIVE_STREAM,
      resolution: MEDIA_PARAMS.MEDIA_RESOLUTION_HD,
      fps: 25,
    },
  }
};

console.log('[Consumer] App Configuration:', appConfig);
console.log('[Consumer] RTMS Configuration:', RTMSManager.redactSecrets(rtmsConfig));

const app = express();
const server = http.createServer(app);

await RTMSManager.init(rtmsConfig);

if (appConfig.managerType === 'webhook') {
  const webhookManager = new WebhookManager({
    config: {
      webhookPath: process.env.WEBHOOK_PATH || '/',
      zoomSecretToken: rtmsConfig.credentials.meeting.zoomSecretToken,
      videoSecretToken: rtmsConfig.credentials.video?.videoSecretToken
    },
    app: app
  });

  webhookManager.on('event', (event, payload) => {
    console.log('[Consumer] Webhook Event:', event, payload);
    RTMSManager.handleEvent(event, payload);
  });

  webhookManager.setup();
  console.log('[Consumer] Webhook Manager initialized');

} else if (appConfig.managerType === 'websocket') {
  const websocketManager = new WebsocketManager({
    config: {
      zoomWSURLForEvents: rtmsConfig.credentials.websocket.zoomWSURLForEvents,
      clientId: rtmsConfig.credentials.websocket.clientId,
      clientSecret: rtmsConfig.credentials.websocket.clientSecret
    }
  });

  websocketManager.on('event', (event, payload) => {
    console.log('[Consumer] Websocket Event:', event, payload);
    RTMSManager.handleEvent(event, payload);
  });

  await websocketManager.start();
  console.log('[Consumer] Websocket Manager initialized');
}

const meetingState = new Map();

RTMSManager.on('audio', ({ buffer, userId, userName, timestamp, meetingId, streamId, productType }) => {
  HelperManager.audio.saveRawAudio(buffer, meetingId, 'mixed', timestamp, streamId, true);
});

RTMSManager.on('video', ({ buffer, userId, userName, timestamp, meetingId, streamId, productType }) => {
  if (!meetingState.has(meetingId)) {
    console.log(`[Consumer] First video for meeting ${meetingId} - creating VideoGapFiller`);
    const videoFiller = new VideoGapFiller({ fps: 25, gapThreshold: 320 });
    
    videoFiller.on('data', ({ buffer: videoBuffer, timestamp: ts, isFiller }) => {
      HelperManager.video.saveRawVideo(videoBuffer, 'mixed', ts, meetingId, streamId, true);
    });
    
    videoFiller.start();
    meetingState.set(meetingId, { videoFiller, streamId });
  }
  
  meetingState.get(meetingId).videoFiller.push(buffer, timestamp);
});

RTMSManager.on('transcript', ({ text, userId, userName, timestamp, meetingId, streamId, productType }) => {
  console.log('[Consumer] Transcript:', { text, userName, productType });
});

RTMSManager.on('meeting.rtms_stopped', async (payload) => {
  const { meeting_uuid, rtms_stream_id } = payload;
  console.log(`[Consumer] RTMS stopped for meeting ${meeting_uuid}`);

  const state = meetingState.get(meeting_uuid);
  if (state) {
    state.videoFiller.stop();
    meetingState.delete(meeting_uuid);
  }

  setTimeout(async () => {
    await HelperManager.audiovideo.convertMeetingMedia(meeting_uuid, rtms_stream_id);
    await HelperManager.audiovideo.muxMixedAudioVideo(meeting_uuid, rtms_stream_id);

    console.log(`[Consumer] Local save complete for meeting ${meeting_uuid}`);

    try {
      await saveToAzure(meeting_uuid, rtms_stream_id);
      console.log(`[Consumer] Azure upload complete for meeting ${meeting_uuid}`);
    } catch (error) {
      console.error(`[Consumer] Azure upload failed for meeting ${meeting_uuid}:`, error.message);
      console.log(`[Consumer] Files are still available locally in recordings/`);
    }
  }, 2000);
});

RTMSManager.on('event', (eventData) => {
  console.log('[Consumer] Event:', eventData);
});

RTMSManager.on('stream_state_changed', (eventData) => {
  console.log('[Consumer] Stream state changed:', eventData);
});

RTMSManager.on('session_state_changed', (eventData) => {
  console.log('[Consumer] Session state changed:', eventData);
});

await RTMSManager.start();

server.listen(appConfig.port, () => {
  console.log(`[Consumer] Server listening on port ${appConfig.port}`);
});

process.on('SIGINT', async () => {
  console.log('[Consumer] Shutting down...');
  for (const [meetingId, state] of meetingState) {
    state.videoFiller.stop();
  }
  meetingState.clear();
  server.close();
  await RTMSManager.stop();
  process.exit(0);
});
