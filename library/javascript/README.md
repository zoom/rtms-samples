# RTMSManager - JavaScript

## Installation

```bash
npm install ws express
```

## Quick Start

```javascript
import { RTMSManager } from './rtmsManager/index.js';
import { WebhookManager } from './webhookManager/WebhookManager.js';
import express from 'express';

const app = express();

// 1. Initialize
await RTMSManager.init({
  credentials: {
    meeting: {
      clientId: process.env.ZOOM_CLIENT_ID,
      clientSecret: process.env.ZOOM_CLIENT_SECRET,
      secretToken: process.env.ZOOM_SECRET_TOKEN,
    }
  },
  mediaTypes: RTMSManager.MEDIA.AUDIO | RTMSManager.MEDIA.TRANSCRIPT,
  logging: 'info'
});

// 2. Handle media events
RTMSManager.on('audio', ({ buffer, userName, timestamp }) => {
  console.log(`Audio from ${userName}: ${buffer.length} bytes`);
});

RTMSManager.on('transcript', ({ text, userName }) => {
  console.log(`${userName}: ${text}`);
});

RTMSManager.on('error', (error) => {
  console.error(error.toString());  // Pretty-printed with causes & fixes
});

// 3. Authenticated webhook endpoint
const webhook = new WebhookManager({
  app,
  config: {
    webhookPath: '/webhook',
    zoomSecretToken: process.env.ZOOM_SECRET_TOKEN
  }
});
webhook.on('event', (event, payload) => {
  RTMSManager.handleEvent(event, payload);
});
webhook.setup();

app.listen(3000);
```

Normal deliveries are verified against the exact raw body using `x-zm-signature`
and `x-zm-request-timestamp`. The default replay window is 300 seconds.

## Media Types

```javascript
RTMSManager.MEDIA.AUDIO        // 1
RTMSManager.MEDIA.VIDEO        // 2
RTMSManager.MEDIA.SHARESCREEN  // 4
RTMSManager.MEDIA.TRANSCRIPT   // 8
RTMSManager.MEDIA.CHAT         // 16
RTMSManager.MEDIA.ALL          // 32

// Combine with bitwise OR
const mediaTypes = RTMSManager.MEDIA.AUDIO | RTMSManager.MEDIA.TRANSCRIPT;  // 9
```

## Presets

```javascript
// Audio only (speech processing)
await RTMSManager.init({ ...RTMSManager.PRESETS.AUDIO_ONLY, credentials });

// Audio + transcript (captions)
await RTMSManager.init({ ...RTMSManager.PRESETS.TRANSCRIPTION, credentials });

// Audio + video (recording)
await RTMSManager.init({ ...RTMSManager.PRESETS.VIDEO_RECORDING, credentials });

// All media types
await RTMSManager.init({ ...RTMSManager.PRESETS.FULL_MEDIA, credentials });
```

## Events

```javascript
// Media events - data object contains: buffer/text, userId, userName, timestamp, meetingId, streamId
RTMSManager.on('audio', ({ buffer, userId, userName, timestamp, meetingId, streamId }) => {});
RTMSManager.on('video', ({ buffer, userId, userName, timestamp, meetingId, streamId }) => {});
RTMSManager.on('sharescreen', ({ buffer, userId, userName, timestamp, meetingId, streamId }) => {});
RTMSManager.on('transcript', ({ text, userId, userName, timestamp, meetingId, streamId }) => {});
RTMSManager.on('chat', ({ text, data, userId, userName, sender, receiver, chatSession, operationType, messageId, parentMessageId, files, deleteFileIdList, timestamp, meetingId, streamId }) => {});

// Lifecycle events
RTMSManager.on('meeting.rtms_started', (payload) => {});
RTMSManager.on('meeting.rtms_stopped', (payload) => {});
RTMSManager.on('participant_video_on', ({ participants, availableParticipants, streamId }) => {});
RTMSManager.on('participant_video_off', ({ participants, availableParticipants, streamId }) => {});
RTMSManager.on('video_subscription_response', ({ userId, success, streamId }) => {});
RTMSManager.on('stream_close_response', ({ success, streamId }) => {});
RTMSManager.on('error', (rtmsError) => {});

// Signaling chat-group lifecycle events. The raw event payload is in `data`.
RTMSManager.on('chat_group_created', ({ data, meetingId, streamId }) => {});
RTMSManager.on('chat_group_deleted', ({ data, meetingId, streamId }) => {});
RTMSManager.on('chat_group_members_added', ({ data, meetingId, streamId }) => {});
RTMSManager.on('chat_group_members_removed', ({ data, meetingId, streamId }) => {});
RTMSManager.on('chat_group_member_status_updated', ({ data, meetingId, streamId }) => {});

Chat metadata is read from the RTMS `content` object, while the original
message data is preserved in `rawData`. Nested JSON payloads are also accepted
for compatibility. Key participant records by `userId` rather than display
name so simultaneous PSTN clients remain distinct.
```

## Individual Video Subscription

```javascript
await RTMSManager.init({
  credentials,
  mediaTypes: RTMSManager.MEDIA.VIDEO,
  mediaParams: {
    video: {
      contentType: RTMSManager.MEDIA_PARAMS.MEDIA_CONTENT_TYPE_RAW_VIDEO,
      codec: RTMSManager.MEDIA_PARAMS.MEDIA_PAYLOAD_TYPE_H264,
      dataOpt: RTMSManager.MEDIA_PARAMS.MEDIA_DATA_OPTION_VIDEO_SINGLE_INDIVIDUAL_STREAM,
      resolution: RTMSManager.MEDIA_PARAMS.MEDIA_RESOLUTION_HD,
      fps: 25
    }
  }
});

RTMSManager.on('participant_video_on', ({ availableParticipants, streamId }) => {
  console.log(streamId, availableParticipants);
});

const participants = RTMSManager.getVideoOnParticipants(streamId);
RTMSManager.subscribeToIndividualVideo(streamId, participants[0].userId);
```

## Configuration

```javascript
await RTMSManager.init({
  credentials: {
    meeting: { clientId: '...', clientSecret: '...', secretToken: '...' },
    videoSdk: { clientId: '...', clientSecret: '...', secretToken: '...' },  // Optional
  },
  mediaTypes: RTMSManager.MEDIA.ALL,
  logging: 'info',            // 'off' | 'error' | 'warn' | 'info' | 'debug'
  logDir: './logs',           // Log file directory
  enableGapFilling: false,    // Insert silence during network drops (for recording)
  protocolDefinitions: {
    // Optional overrides for the July 2026 protocol definitions
    messageTypes: { STREAM_CLOSE_REQ: 21, STREAM_CLOSE_RESP: 22, VIDEO_SUBSCRIPTION_REQ: 28, VIDEO_SUBSCRIPTION_RESP: 29 },
    eventTypes: {
      PARTICIPANT_VIDEO_ON: 8,
      PARTICIPANT_VIDEO_OFF: 9,
      CHAT_GROUP_CREATE: 10,
      CHAT_GROUP_DELETE: 11,
      CHAT_GROUP_MEMBERS_ADD: 12,
      CHAT_GROUP_MEMBERS_DELETE: 13,
      CHAT_GROUP_MEMBER_STATUS_UPDATE: 14
    },
    statusCodes: {
      INVALID_MEDIA_TRANSCRIPT_TARGET_LANGUAGE: 46,
      CHAT_SESSION_KEY_NOT_AVAILABLE: 47
    },
    mediaDataOptions: { VIDEO_SINGLE_INDIVIDUAL_STREAM: 4 }
  }
});
```

## Full Documentation

See [library/README.md](../README.md) for complete documentation including:
- Helper classes (WebhookManager, FrontendWssManager, FrontendManager)
- Utilities (FileLogger, RTMSError, signatureHelper)
- Advanced features (reconnection, state management, gap filling)
- Architecture overview
