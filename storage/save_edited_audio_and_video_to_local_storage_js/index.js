import { RTMSManager } from '../../library/javascript/rtmsManager/RTMSManager.js';
import WebhookManager from '../../library/javascript/webhookManager/WebhookManager.js';
import WebsocketManager from '../../library/javascript/webSocketManager/WebsocketManager.js';
import HelperManager, { VideoGapFiller } from '../../library/javascript/commonHelpers/HelperManager.js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import http from 'http';
import { RecordingStore, sanitizeId } from './lib/recordingStore.js';
import { createEditorWorkflow } from './lib/editorWorkflow.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '.env') });
process.chdir(__dirname);

const { MEDIA_PARAMS } = RTMSManager;

const appConfig = {
  port: process.env.PORT || 3000,
  managerType: process.env.RTMSTRIGGERMANAGERTYPE || 'webhook',
};

const recordingsRoot = path.join(__dirname, 'recordings');
const recordingStore = new RecordingStore(recordingsRoot);
const aiConfig = {
  apiUrl: process.env.AI_API_URL,
  apiKey: process.env.AI_API_KEY,
  model: process.env.AI_MODEL,
  minSegmentMs: Number(process.env.AI_MIN_SEGMENT_MS || 800),
  maxOutputMs: Number(process.env.AI_MAX_OUTPUT_SECONDS || 300) * 1000,
};
const editorWorkflow = createEditorWorkflow({ recordingsRoot, aiConfig });

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
  mediaTypesFlag: parseInt(process.env.MEDIA_TYPES_FLAG || '11'),
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
      contentType: MEDIA_PARAMS.MEDIA_CONTENT_TYPE_RAW_AUDIO,
      sampleRate: MEDIA_PARAMS.AUDIO_SAMPLE_RATE_SR_16K,
      channel: MEDIA_PARAMS.AUDIO_CHANNEL_MONO,
      codec: MEDIA_PARAMS.MEDIA_PAYLOAD_TYPE_L16,
      dataOpt: MEDIA_PARAMS.MEDIA_DATA_OPTION_AUDIO_MIXED_STREAM,
      sendRate: 20,
    },
    video: {
      contentType: MEDIA_PARAMS.MEDIA_CONTENT_TYPE_RAW_VIDEO,
      codec: MEDIA_PARAMS.MEDIA_PAYLOAD_TYPE_H264,
      dataOpt: MEDIA_PARAMS.MEDIA_DATA_OPTION_VIDEO_SINGLE_ACTIVE_STREAM,
      resolution: MEDIA_PARAMS.MEDIA_RESOLUTION_HD,
      fps: 25,
    },
    transcript: {
      contentType: MEDIA_PARAMS.MEDIA_CONTENT_TYPE_TEXT,
      language: MEDIA_PARAMS.LANGUAGE_ID_ENGLISH,
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
  recordingStore.noteMedia(meetingId, streamId, timestamp);
  HelperManager.audio.saveRawAudio(buffer, meetingId, 'mixed', timestamp, streamId, true);
});

RTMSManager.on('video', ({ buffer, userId, userName, timestamp, meetingId, streamId, productType }) => {
  recordingStore.noteMedia(meetingId, streamId, timestamp);
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

RTMSManager.on('transcript', (event) => {
  recordingStore.addTranscript(event);
  console.log('[Consumer] Transcript:', { text: event.text, userName: event.userName, productType: event.productType });
});

RTMSManager.on('meeting.rtms_stopped', async (payload) => {
  const { meeting_uuid, rtms_stream_id } = payload;
  console.log(`[Consumer] RTMS stopped for meeting ${meeting_uuid}`);

  const state = meetingState.get(meeting_uuid);
  if (state) {
    state.videoFiller.stop();
    meetingState.delete(meeting_uuid);
  }

  setTimeout(() => {
    void finalizeRecording(meeting_uuid, rtms_stream_id).catch((error) => {
      console.error('[Editor] Post-meeting processing failed:', error);
    });
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
  console.log(`Webhook available at http://localhost:${appConfig.port}${process.env.WEBHOOK_PATH || '/'}`);
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

async function finalizeRecording(meetingId, streamId) {
  await recordingStore.finalize(meetingId, streamId);
  await HelperManager.audiovideo.convertMeetingMedia(meetingId, streamId);
  await HelperManager.audiovideo.muxMixedAudioVideo(meetingId, streamId);
  console.log(`[Editor] Recording ready: ${sanitizeId(meetingId)}/${sanitizeId(streamId)}`);

  if (process.env.AI_AUTO_EDIT_ON_STOP === 'true') {
    const params = { meetingId: sanitizeId(meetingId), streamId: sanitizeId(streamId) };
    const brief = process.env.AI_DEFAULT_EDITING_BRIEF || 'Create a concise meeting highlight video.';
    const planned = await editorWorkflow.createPlan(params, brief);
    const outputPath = await editorWorkflow.renderSavedPlan(params, planned.plan);
    console.log(`[Editor] Automatic edit rendered: ${outputPath}`);
  }
}
