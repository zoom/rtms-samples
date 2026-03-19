# Start/Stop RTMS Control

A Zoom App that demonstrates programmatic control of RTMS streaming using the Zoom Apps SDK, with buttons to start, stop, pause, and resume RTMS from within a meeting.

> **Built with [RTMSManager](../../library/README.md)** - Zoom's JavaScript library for real-time media streaming.

## Quick Start

```bash
npm install
cp .env.example .env   # Fill in your credentials
node index.js
```

Expose with ngrok: `ngrok http 3000`

## What This Sample Does

This sample demonstrates how to control RTMS streaming directly from within a Zoom meeting using the Zoom Apps SDK. The frontend provides buttons to call `zoomSdk.startRTMS()`, `zoomSdk.stopRTMS()`, `zoomSdk.pauseRTMS()`, and `zoomSdk.resumeRTMS()`. It also subscribes to `onRTMSStatusChange` events to display real-time status updates. The backend supports both webhook and WebSocket modes for receiving Zoom events, and streams media data (audio, video, transcripts, screenshare, chat) to connected frontend clients.

## Prerequisites

- Node.js v18+
- Zoom account with RTMS enabled
- Zoom App configured in Marketplace with RTMS APIs enabled
- Server-to-Server OAuth app (optional, for advanced API calls)
- ngrok for local development

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ZOOM_SECRET_TOKEN` | Yes | Webhook validation token from Zoom Marketplace |
| `ZOOM_CLIENT_ID` | Yes | Your Zoom App's Client ID |
| `ZOOM_CLIENT_SECRET` | Yes | Your Zoom App's Client Secret |
| `PORT` | No | Server port (default: 3000) |
| `WEBHOOK_PATH` | No | Webhook endpoint path (default: /webhook) |
| `WS_URL` | No | WebSocket URL for frontend connection |
| `MODE` | No | Event delivery mode: "webhook" or "websocket" (default: webhook) |
| `zoomWSURLForEvents` | No | Zoom WebSocket URL for event subscription (websocket mode only) |
| `ZOOM_S2S_CLIENT_ID` | No | Server-to-Server OAuth Client ID |
| `ZOOM_S2S_CLIENT_SECRET` | No | Server-to-Server OAuth Client Secret |
| `ZOOM_ACCOUNT_ID` | No | Zoom Account ID for S2S OAuth |

## Code Walkthrough

### RTMSManager Configuration with Multiple Media Types

```javascript
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
```

### Frontend RTMS Control Buttons

```javascript
// Start RTMS from within the meeting
startRtmsBtn.addEventListener('click', async () => {
  if (runningContext.context === 'inMeeting') {
    const rtmsResponse = await zoomSdk.startRTMS();
    console.debug('RTMS Start Response:', rtmsResponse);
  }
});

// Stop RTMS
stopRtmsBtn.addEventListener('click', async () => {
  if (runningContext.context === 'inMeeting') {
    const rtmsResponse = await zoomSdk.stopRTMS();
    console.debug('RTMS Stop Response:', rtmsResponse);
  }
});

// Pause RTMS (temporarily stop streaming)
pauseRtmsBtn.addEventListener('click', async () => {
  if (runningContext.context === 'inMeeting') {
    const rtmsResponse = await zoomSdk.pauseRTMS();
    console.debug('RTMS Pause Response:', rtmsResponse);
  }
});

// Resume RTMS after pause
resumeRtmsBtn.addEventListener('click', async () => {
  if (runningContext.context === 'inMeeting') {
    const rtmsResponse = await zoomSdk.resumeRTMS();
    console.debug('RTMS Resume Response:', rtmsResponse);
  }
});
```

### RTMS Status Monitoring

```javascript
// Get current RTMS status on demand
getRtmsStatusBtn.addEventListener('click', async () => {
  const rtmsStatus = await zoomSdk.getRTMSStatus();
  console.log("RTMS Status:", rtmsStatus);
  
  if (Array.isArray(rtmsStatus.rtmsStatus) && rtmsStatus.rtmsStatus.length === 0) {
    statusBox.textContent = 'No RTMS sessions currently active.';
  } else {
    statusBox.textContent = JSON.stringify(rtmsStatus, null, 2);
  }
});

// Subscribe to real-time status changes
zoomSdk.on('onRTMSStatusChange', (event) => {
  console.log('RTMS Status Changed:', event);
  statusBox.textContent = `RTMS Status: ${JSON.stringify(event)}`;
});
```

### Backend Media Event Handling

```javascript
RTMSManager.on('audio', ({ buffer, userId, userName, timestamp, meetingId }) => {
  console.log(`Audio received from ${userName || 'mixed'} (${buffer.length} bytes)`);
  frontendWss.broadcastToMeeting(meetingId, {
    type: 'audio',
    user: userName || 'mixed',
    size: buffer.length,
    timestamp
  });
});

RTMSManager.on('video', ({ buffer, userId, userName, timestamp, meetingId }) => {
  console.log(`Video received from ${userName} (${buffer.length} bytes)`);
  frontendWss.broadcastToMeeting(meetingId, { type: 'video', user: userName, size: buffer.length });
});

RTMSManager.on('transcript', ({ text, userId, userName, timestamp, meetingId }) => {
  console.log(`Transcript from ${userName}: ${text}`);
  frontendWss.broadcastToUser(meetingId, String(userId), {
    type: 'transcript',
    user: userName,
    content: text,
    timestamp
  });
});
```

### WebSocket Event Mode (Alternative to Webhooks)

```javascript
if (config.mode === 'websocket') {
  // Authenticate and connect to Zoom's event WebSocket
  const fullWsUrl = `${config.zoomWSURLForEvents}&access_token=${accessToken}`;
  const eventWs = new WebSocket(fullWsUrl);

  eventWs.on('open', () => {
    console.log('Connected to Zoom Events WebSocket');
    // Send heartbeat to keep connection alive
    setInterval(() => {
      eventWs.send(JSON.stringify({ module: 'heartbeat' }));
    }, 30000);
  });

  eventWs.on('message', async (message) => {
    const msg = JSON.parse(message.toString());
    if (msg.module === 'message' && msg.content) {
      const eventData = JSON.parse(msg.content);
      RTMSManager.handleEvent(eventData.event, eventData.payload);
    }
  });
}
```

## Key Files

| File | Purpose |
|------|---------|
| `index.js` | Main application - RTMSManager setup, media handlers, webhook/websocket modes |
| `s2sZoomApiClient.js` | Server-to-Server OAuth client for Zoom API calls |
| `views/index.ejs` | Frontend with RTMS control buttons and status display |
| `.env.example` | Environment variable template |

## How It Works

1. **Zoom SDK Configuration**: Frontend configures the Zoom Apps SDK with RTMS capabilities:
   - `startRTMS`, `stopRTMS`, `pauseRTMS`, `resumeRTMS`, `getRTMSStatus`, `onRTMSStatusChange`
2. **User Interaction**: Meeting participant clicks Start/Stop/Pause/Resume buttons
3. **SDK API Call**: Frontend calls corresponding `zoomSdk` method
4. **Webhook Delivery**: Zoom sends webhook events (`meeting.rtms_started`, `meeting.rtms_stopped`) to backend
5. **RTMSManager Processing**: Backend handles events and connects to RTMS stream
6. **Media Streaming**: Audio, video, transcripts, screenshare, and chat data flow through event handlers
7. **Frontend Updates**: Backend broadcasts media info and status to connected frontend clients

## Troubleshooting

| Issue | Solution |
|-------|----------|
| "Cannot start RTMS: Not in a meeting context" | Ensure the Zoom App is opened during an active meeting |
| RTMS buttons not responding | Verify RTMS APIs are enabled in Zoom Marketplace > Features > Surface > Zoom App SDK |
| Webhook not received | Check `ZOOM_SECRET_TOKEN` matches Marketplace and ngrok URL is configured |
| WebSocket mode not connecting | Verify `zoomWSURLForEvents` includes valid subscription ID |
| No status updates | Ensure `onRTMSStatusChange` is in the SDK capabilities list |

## See Also

- [RTMSManager Library Docs](../../library/README.md) - Full API reference
- [Zoom App Setup Guide](../../ZOOM_APP_SETUP.md) - Configure your Zoom app
- [Troubleshooting Guide](../../TROUBLESHOOTING.md) - Common issues
