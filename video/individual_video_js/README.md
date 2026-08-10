# RTMS JavaScript Individual Video Boilerplate

A production-ready reference implementation for receiving real-time audio, video, screen share, transcript, and chat data from Zoom meetings.

> **Built with [RTMSManager](../../library/README.md)** - Zoom's JavaScript library for real-time media streaming.

## Quick Start

```bash
npm install
cp .env.example .env   # Fill in your credentials
node index.js
```

Expose with ngrok: `ngrok http 3000`

## What This Sample Does

This is the main reference implementation for RTMS in JavaScript. It demonstrates the complete RTMSManager setup with all event handlers for processing real-time media streams. The sample supports both webhook and WebSocket event sources, includes a frontend WebSocket server for broadcasting data to browser clients, and provides a web interface for monitoring live transcripts and chat.

## Prerequisites

- Node.js v18+
- Zoom account with RTMS enabled
- Zoom App credentials (Client ID, Client Secret, Secret Token)
- Optional: Server-to-Server OAuth credentials for API calls
- Optional: Video SDK credentials (if using Video SDK)
- ngrok for local development

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ZOOM_SECRET_TOKEN` | Yes | Webhook validation token from Zoom Marketplace |
| `ZOOM_CLIENT_ID` | Yes | OAuth Client ID for your Zoom app |
| `ZOOM_CLIENT_SECRET` | Yes | OAuth Client Secret for your Zoom app |
| `PORT` | No | Server port (default: 3000) |
| `WEBHOOK_PATH` | No | Webhook endpoint path (default: `/webhook`) |
| `FRONTEND_WSS_URL_TO_CONNECT_TO` | No | WebSocket URL for frontend clients |
| `zoomWSURLForEvents` | No | Zoom WebSocket URL for event subscription |
| `ZOOM_S2S_CLIENT_ID` | No | Server-to-Server OAuth Client ID |
| `ZOOM_S2S_CLIENT_SECRET` | No | Server-to-Server OAuth Client Secret |
| `ZOOM_ACCOUNT_ID` | No | Zoom Account ID for S2S OAuth |
| `MEDIA_TYPES_FLAG` | No | Bitmask for media types (default: 32 = all) |
| `VIDEO_CLIENT_ID` | No | Video SDK Client ID |
| `VIDEO_CLIENT_SECRET` | No | Video SDK Client Secret |
| `VIDEO_SECRET_TOKEN` | No | Video SDK webhook secret token |
| `MEDIA_SOCKET_CONNECTION_MODE` | No | Socket mode: `unified` or `split` |
| `AUDIO_STREAM_MODE` | No | Audio mode: `mixed` or `multi` |
| `VIDEO_STREAM_MODE` | No | Video mode: `active`, `individual`, or `speaker` |
| `RTMSTRIGGERMANAGERTYPE` | No | Event source: `webhook` (default) or `websocket` |
| `SERVE_STATIC_ENABLED` | No | Enable static file serving (default: true) |
| `FRONTEND_WSS_PATH` | No | WebSocket path for frontend (default: `/ws`) |

## Code Walkthrough

### 1. Initialize RTMS Configuration

```javascript
import { RTMSManager } from '../../library/javascript/rtmsManager/RTMSManager.js';

const { MEDIA_PARAMS } = RTMSManager;

const rtmsConfig = {
  logging: {
    enabled: true,
    logDir: path.join(__dirname, 'logs'),
    console: true
  },
  mediaSocketConnectionMode: process.env.MEDIA_SOCKET_CONNECTION_MODE || 'split',
  mediaTypesFlag: parseInt(process.env.MEDIA_TYPES_FLAG || '32'),
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
      dataOpt: getAudioDataOptFromEnv(),
      sendRate: 100,
    },
    video: {
      contentType: MEDIA_PARAMS.MEDIA_CONTENT_TYPE_RAW_VIDEO,
      codec: MEDIA_PARAMS.MEDIA_PAYLOAD_TYPE_H264,
      dataOpt: getVideoDataOptFromEnv(),
      resolution: MEDIA_PARAMS.MEDIA_RESOLUTION_HD,
      fps: 25,
    },
    transcript: {
      contentType: MEDIA_PARAMS.MEDIA_CONTENT_TYPE_TEXT,
      language: MEDIA_PARAMS.LANGUAGE_ID_ENGLISH,
    }
  }
};
```

### Video Mode From `.env`

You can now switch media subscription style without editing code:

```env
MEDIA_TYPES_FLAG=2
AUDIO_STREAM_MODE=mixed
VIDEO_STREAM_MODE=active
```

Supported values:

- `AUDIO_STREAM_MODE=mixed`
- `AUDIO_STREAM_MODE=multi`
- `VIDEO_STREAM_MODE=active`
- `VIDEO_STREAM_MODE=individual`
- `VIDEO_STREAM_MODE=speaker`

For individual participant video, use:

```env
MEDIA_TYPES_FLAG=2
VIDEO_STREAM_MODE=individual
MEDIA_SOCKET_CONNECTION_MODE=split
```

Then the sample waits for RTMS to send a real `userId` in `participant_video_on` / `video_on_participants_changed`, logs the valid candidates, and auto-subscribes to the first available participant.

If you want to do it manually instead, call:

```javascript
RTMSManager.subscribeToIndividualVideo(streamId, userId);
```

### 2. Initialize Managers

```javascript
// Create Express App and HTTP Server
const app = express();
const server = http.createServer(app);

// Initialize RTMS Manager (Core Logic)
await RTMSManager.init(rtmsConfig);

// Initialize Frontend Manager (Static Files & Views)
const frontendManager = new FrontendManager({
  config: { 
    port: appConfig.port,
    serveStaticEnabled: process.env.SERVE_STATIC_ENABLED !== 'false',
    viewsPath: path.join(__dirname, '../../library/javascript/rtmsManager/public/views'),
    frontendWssUrl: process.env.FRONTEND_WSS_URL_TO_CONNECT_TO || ''
  },
  app: app
});
frontendManager.setup();

// Initialize Frontend WSS Manager (Real-time Frontend Communication)
const frontendWssManager = new FrontendWssManager({
  config: { 
    frontendWssEnabled: true,
    frontendWssPath: process.env.FRONTEND_WSS_PATH || '/ws' 
  },
  server: server
});
frontendWssManager.setup();
```

### 3. Set Up Webhook Handler

```javascript
if (appConfig.managerType === 'webhook') {
  const webhookManager = new WebhookManager({
    config: {
      webhookPath: process.env.WEBHOOK_PATH || '/',
      zoomSecretToken: rtmsConfig.credentials.meeting.zoomSecretToken,
      videoSecretToken: rtmsConfig.credentials.video.videoSecretToken
    },
    app: app
  });

  webhookManager.on('event', (event, payload) => {
    console.log('[Consumer] Webhook Event:', event, payload);
    RTMSManager.handleEvent(event, payload);
  });

  webhookManager.setup();
}
```

### 4. Register Media Event Handlers

```javascript
RTMSManager.on('audio', ({ buffer, userId, userName, timestamp, meetingId, streamId, productType }) => {
  // Process audio data here
});

RTMSManager.on('video', ({ buffer, userId, userName, timestamp, meetingId, streamId, productType }) => {
  // Process video data here
});

RTMSManager.on('transcript', ({ text, userId, userName, timestamp, meetingId, streamId, productType, startTime, endTime, language, attribute }) => {
  console.log('[Consumer] Transcript:', { text, userName, language });
  
  // Broadcast to frontend clients
  frontendWssManager.broadcastToMeeting(meetingId, {
    type: 'transcript',
    text,
    userName,
    timestamp,
    language
  });
});

RTMSManager.on('chat', ({ text, userId, userName, sender, timestamp, meetingId, streamId, productType }) => {
  const displayName = userName ?? sender?.userName ?? sender?.user_name ?? `user ${userId ?? 'unknown'}`;
  console.log(`[Consumer] Chat from ${displayName}: ${text}`);
  
  frontendWssManager.broadcastToMeeting(meetingId, {
    type: 'chat',
    text,
    userName: displayName,
    timestamp
  });
});
```

### 5. Start the Server

```javascript
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
```

## Key Files

| File | Purpose |
|------|---------|
| `index.js` | Main entry point with complete RTMSManager setup, event handlers, and server configuration |
| `package.json` | Dependencies including rtms-manager library reference |
| `.env.example` | Template for all supported environment variables |

## How It Works

1. **Server starts** and initializes RTMSManager with media configuration
2. **WebhookManager** listens for Zoom webhook events at the configured endpoint
3. **Zoom sends `meeting.rtms_started`** webhook when RTMS begins in a meeting
4. **RTMSManager** automatically connects to signaling and media WebSockets
5. **Media events fire** as data arrives (audio, video, transcript, chat)
6. **FrontendWssManager** broadcasts data to connected browser clients
7. **Zoom sends `meeting.rtms_stopped`** webhook when streaming ends
8. **RTMSManager** cleans up connections and archives stream metadata

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Webhook not received | Verify ngrok URL is set in Zoom Marketplace, check webhook path matches |
| "Invalid signature" error | Ensure `ZOOM_CLIENT_ID` and `ZOOM_CLIENT_SECRET` match your Zoom app |
| No media data | Check `MEDIA_TYPES_FLAG` includes video (`2`, or `3` when audio is also needed) |
| Frontend not receiving data | Verify `FRONTEND_WSS_URL_TO_CONNECT_TO` points to your server's WebSocket |
| Connection drops | Check network stability; RTMSManager auto-reconnects after 3 seconds |

## See Also

- [RTMSManager Library Docs](../../library/README.md) - Full API reference
- [Zoom App Setup Guide](../../ZOOM_APP_SETUP.md) - Configure your Zoom app
- [Troubleshooting Guide](../../TROUBLESHOOTING.md) - Common issues
