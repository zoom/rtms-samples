import { RTMSManager } from '../../library/javascript/rtmsManager/RTMSManager.js';
import WebhookManager from '../../library/javascript/webhookManager/WebhookManager.js';
import WebsocketManager from '../../library/javascript/webSocketManager/WebsocketManager.js';
import HelperManager from '../../library/javascript/commonHelpers/HelperManager.js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import http from 'http';

import { saveToS3 } from './S3StorageHelper.js';

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
  enableRealTimeAudioVideoGapFiller: true,
  mediaSocketConnectionMode: process.env.MEDIA_SOCKET_CONNECTION_MODE || 'split',
  mediaTypesFlag: parseInt(process.env.MEDIA_TYPES_FLAG || '3'), // Audio + Video
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
      sendRate: 100,
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

// 1. Create Express App and HTTP Server
const app = express();
const server = http.createServer(app);

// 2. Initialize RTMS Manager (Core Logic)
await RTMSManager.init(rtmsConfig);

// 3. Initialize Event Source Managers based on config
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

// 4. Register media/event handlers
RTMSManager.on('audio', ({ buffer, userId, userName, timestamp, meetingId, streamId, productType }) => {
  const audioDetails = RTMSManager.getAudioDetails(streamId) || {};
  const isMixed = audioDetails.data_opt === RTMSManager.MEDIA_PARAMS.MEDIA_DATA_OPTION_AUDIO_MIXED_STREAM;
  HelperManager.audio.saveRawAudio(buffer, meetingId, userId, timestamp, streamId, isMixed);
});

RTMSManager.on('video', ({ buffer, userId, userName, timestamp, meetingId, streamId, productType }) => {
  const videoDetails = RTMSManager.getVideoDetails(streamId) || {};
  const isMixed = videoDetails.data_opt === RTMSManager.MEDIA_PARAMS.MEDIA_DATA_OPTION_VIDEO_SINGLE_ACTIVE_STREAM;
  HelperManager.video.saveRawVideo(buffer, userId, timestamp, meetingId, streamId, isMixed);
});

RTMSManager.on('transcript', ({ text, userId, userName, timestamp, meetingId, streamId, productType }) => {
  console.log('[Consumer] Transcript:', { text, userName, productType });
});

RTMSManager.on('meeting.rtms_stopped', async (payload) => {
  const { meeting_uuid, rtms_stream_id } = payload;
  console.log(`[Consumer] RTMS stopped for meeting ${meeting_uuid}`);

  const audioDetails = RTMSManager.getAudioDetails(rtms_stream_id) || {};
  const videoDetails = RTMSManager.getVideoDetails(rtms_stream_id) || {};
  const isAudioMixed = audioDetails.data_opt === RTMSManager.MEDIA_PARAMS.MEDIA_DATA_OPTION_AUDIO_MIXED_STREAM;
  const isVideoMixed = videoDetails.data_opt === RTMSManager.MEDIA_PARAMS.MEDIA_DATA_OPTION_VIDEO_SINGLE_ACTIVE_STREAM;

  setTimeout(async () => {
    await HelperManager.audiovideo.convertMeetingMedia(meeting_uuid, rtms_stream_id);

    if (isAudioMixed && isVideoMixed) {
      await HelperManager.audiovideo.muxMixedAudioVideo(meeting_uuid, rtms_stream_id);
    }

    console.log(`[Consumer] Local save complete for meeting ${meeting_uuid}`);

    try {
      await saveToS3(meeting_uuid, rtms_stream_id);
      console.log(`[Consumer] S3 upload complete for meeting ${meeting_uuid}`);
    } catch (error) {
      console.error(`[Consumer] S3 upload failed for meeting ${meeting_uuid}:`, error.message);
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

// 5. Start the Server and RTMS Manager
await RTMSManager.start();

server.listen(appConfig.port, () => {
  console.log(`[Consumer] Server listening on port ${appConfig.port}`);
});

process.on('SIGINT', async () => {
  console.log('[Consumer] Shutting down...');
  server.close();
  await RTMSManager.stop();
  process.exit(0);
});
