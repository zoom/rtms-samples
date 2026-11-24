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

// Combine with bitwise OR
const mediaTypes = RTMSManager.MEDIA.AUDIO | RTMSManager.MEDIA.TRANSCRIPT;  // 9
```

Each selected flag opens a separate data connection. Unified media socket mode
and `media_type: 32` are deprecated; send exactly one concrete media type in
each data handshake.

## RTMS Protocol V2

The library uses RTMS protocol V2 by default:

- Both the signaling and data handshakes send `protocol_version: 2`. Set
  `protocolVersion: 1` in `RTMSManager.init()` to fall back to V1. Zoom Phone
  always uses V2.
- Each media type has its own data connection. V2 rejects `media_type: 32`
  (ALL) with status `48`.
- Event subscriptions are sent with `event_code` (session events `1000` to
  `1011`). `'event'` payloads carry `eventCode` (V2) and the equivalent legacy
  `eventType`, so compare against `RTMSManager.EVENT_CODES`:

```javascript
RTMSManager.on('event', ({ eventCode, data }) => {
  if (eventCode === RTMSManager.EVENT_CODES.PARTICIPANT_JOIN) {
    console.log('Joined:', data.participants);
  }
});
```

- Comma-separated `server_urls` values (`wss://...,srt://...`) resolve to the
  allowed `wss://` entry, and a single `media_server.server_urls` string serves
  every media type.
- New events: `media_connection_interrupted` reports `mediaType`,
  `video_subscription_terminated` reports `connectionId`, and
  `media_data_user_info` lists the participants observed on a media type.
  Rejected requests (`REQUEST_ERROR_RESP`, `msg_type 30`) and the V2 status
  codes `44`, `45` and `48` to `58` surface as `RTMSError` on `'error'`.

## Presets

```javascript
// Audio only (speech processing)
await RTMSManager.init({ ...RTMSManager.PRESETS.AUDIO_ONLY, credentials });

// Audio + transcript (captions)
await RTMSManager.init({ ...RTMSManager.PRESETS.TRANSCRIPTION, credentials });

// Audio + video (recording)
await RTMSManager.init({ ...RTMSManager.PRESETS.VIDEO_RECORDING, credentials });

// Zoom Phone: per-channel call audio + transcript over protocol V2
await RTMSManager.init({ ...RTMSManager.PRESETS.PHONE, credentials });
```

## Zoom Phone

RTMSManager handles [Zoom Phone RTMS](https://developers.zoom.us/docs/rtms/phone/)
with the same API as meetings. Subscribe your General app to
`phone.call_rtms_started`, `phone.call_rtms_stopped`, and
`phone.call_rtms_interrupted`, add the `phone:read:voice_call_audio` and
`phone:read:voice_call_transcript` scopes, and forward the webhooks to
`RTMSManager.handleEvent()`.

```javascript
await RTMSManager.init({
  ...RTMSManager.PRESETS.PHONE,
  credentials: {
    phone: { clientId: '...', clientSecret: '...', secretToken: '...' }
  }
});

// Phone speakers are identified by channelId (also exposed as userId).
// Names are filled from CALL_INFO_UPDATED when available.
RTMSManager.on('transcript', ({ productType, rtmsId, channelId, userName, sentenceId, isUpdate, text }) => {
  // Key sentences by (channelId, sentenceId). isUpdate means "replace the
  // sentence text"; 0 is a valid sentenceId.
});
RTMSManager.on('audio', ({ channelId, buffer }) => {}); // raw PCM per channel

RTMSManager.on('phone_call_info_updated', ({ hostChannelId, participants }) => {});
RTMSManager.on('phone_call_hold', ({ rtmsId }) => {});
RTMSManager.on('phone_call_resume', ({ rtmsId }) => {});
RTMSManager.on('phone_call_transfer_completed', ({ transferType, transferResult }) => {});

RTMSManager.getPhoneCallInfo(streamId); // { hostChannelId, participants: [{ channelId, name, number }] }
```

The manager applies the Phone protocol details automatically:

- Signs and handshakes with `call_id` and RTMS protocol V2.
- Selects the `wss://` entry when `server_urls` also lists `srt://` URLs.
- Opens separate audio (`1`) and transcript (`8`) sockets without
  meeting-style `media_params`, then sends a client-ready ACK for each.
- Rebuilds the stream when `phone.call_rtms_started` repeats for an active
  stream (server failover), and reconnects with stored URLs on
  `phone.call_rtms_interrupted`.

`rtmsId` is the Phone `call_id`. See
[`phone/print_phone_transcript_js`](../../phone/print_phone_transcript_js/)
for a runnable sample.

## Transcript rewind

RTMS can send a transcript sentence and later a corrected version of it. The
correction reuses the same `sentenceId`, sets `isUpdate: true` (`attribute: 2`),
and carries the full replacement text. Replace the earlier sentence instead of
appending a new line. This applies to meetings, webinars, Video SDK, Contact
Center, and Phone transcripts. `sentenceId` is `null` when the server does not
send one, and `0` is a valid ID.

`TranscriptRevisionStore` does the bookkeeping. It keys sentences by
`(streamId, channelId or userId, sentenceId)`, because Phone sentence IDs repeat
across channels.

```javascript
import { RTMSManager, TranscriptRevisionStore } from 'rtms-manager-dev';

const transcript = new TranscriptRevisionStore();

RTMSManager.on('transcript', (event) => {
  const { action, sentence } = transcript.apply(event);
  // action: 'new' | 'updated' | 'recovered' | 'replaced'
  // 'updated' and 'recovered' mean redraw or re-analyze `sentence`, not append it.
});

RTMSManager.on('meeting.rtms_stopped', ({ rtms_stream_id }) => transcript.clear(rtms_stream_id));

transcript.sentences(streamId); // latest text of every sentence, in start-time order
```

## Events

```javascript
// Media events - data object contains: buffer/text, userId, userName, timestamp, meetingId, streamId
RTMSManager.on('audio', ({ buffer, userId, userName, timestamp, meetingId, streamId }) => {});
RTMSManager.on('video', ({ buffer, userId, userName, timestamp, meetingId, streamId }) => {});
RTMSManager.on('sharescreen', ({ buffer, userId, userName, timestamp, meetingId, streamId }) => {});
RTMSManager.on('transcript', ({ text, userId, userName, timestamp, meetingId, streamId, startTime, endTime, language, sentenceId, isUpdate, attribute, channelId }) => {});
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
  mediaTypes: RTMSManager.MEDIA.AUDIO | RTMSManager.MEDIA.TRANSCRIPT,
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

See [library/readme.md](../readme.md) for complete documentation including:
- Helper classes (WebhookManager, FrontendWssManager, FrontendManager)
- Utilities (FileLogger, RTMSError, signatureHelper)
- Advanced features (reconnection, state management, gap filling)
- Architecture overview
