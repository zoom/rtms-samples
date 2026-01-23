# RTMSManager - JavaScript

## Installation

```bash
npm install ws express
```

## Quick Start

```javascript
import { RTMSManager } from './rtmsManager/index.js';
import express from 'express';

const app = express();
app.use(express.json());

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

// 3. Webhook endpoint
app.post('/webhook', (req, res) => {
  const { event, payload } = req.body;
  
  // Handle URL validation challenge
  if (event === 'endpoint.url_validation') {
    const hashForValidate = crypto
      .createHmac('sha256', process.env.ZOOM_SECRET_TOKEN)
      .update(payload.plainToken)
      .digest('hex');
    return res.json({ plainToken: payload.plainToken, encryptedToken: hashForValidate });
  }
  
  // Feed RTMS events to manager
  RTMSManager.handleEvent(event, payload);
  res.status(200).send();
});

app.listen(3000);
```

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
RTMSManager.on('chat', ({ text, userId, userName, timestamp, meetingId, streamId }) => {});

// Lifecycle events
RTMSManager.on('meeting.rtms_started', (payload) => {});
RTMSManager.on('meeting.rtms_stopped', (payload) => {});
RTMSManager.on('error', (rtmsError) => {});
```

## Configuration

```javascript
await RTMSManager.init({
  credentials: {
    meeting: { clientId, clientSecret, secretToken },
    videoSdk: { clientId, clientSecret, secretToken },  // Optional
  },
  mediaTypes: RTMSManager.MEDIA.ALL,
  logging: 'info',            // 'off' | 'error' | 'warn' | 'info' | 'debug'
  logDir: './logs',           // Log file directory
  enableGapFilling: false,    // Insert silence during network drops (for recording)
});
```

## Full Documentation

See [library/README.md](../README.md) for complete documentation including:
- Helper classes (WebhookManager, FrontendWssManager, FrontendManager)
- Utilities (FileLogger, RTMSError, signatureHelper)
- Advanced features (reconnection, state management, gap filling)
- Architecture overview
