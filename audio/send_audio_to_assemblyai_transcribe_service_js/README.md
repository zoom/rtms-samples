# Send Audio to AssemblyAI Transcription Service

Stream Zoom meeting audio to AssemblyAI for real-time speech-to-text transcription.

> **Built with [RTMSManager](../../library/README.md)** - Zoom's JavaScript library for real-time media streaming.

## Quick Start

```bash
npm install
cp .env.example .env   # Fill in your credentials
node index.js
```

Expose with ngrok: `ngrok http 5050`

## What This Sample Does

This sample captures live audio from Zoom meetings and streams it to AssemblyAI's real-time transcription API. It supports both mixed audio (all participants combined) and individual participant streams. The sample manages per-meeting audio collection and handles WebSocket connections to AssemblyAI with automatic reconnection on errors.

## Prerequisites

- Node.js v18+
- Zoom account with RTMS enabled
- AssemblyAI account with API key
- ngrok for local development

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ZOOM_SECRET_TOKEN` | Yes | Your Zoom app's secret token for webhook validation |
| `ZOOM_CLIENT_ID` | Yes | Your Zoom app's client ID |
| `ZOOM_CLIENT_SECRET` | Yes | Your Zoom app's client secret |
| `PORT` | No | Server port (default: 5050) |
| `WEBHOOK_PATH` | No | Webhook endpoint path (default: /) |
| `ASSEMBLYAI_API_KEY` | Yes | Your AssemblyAI API key |
| `REALTIME_ENABLED` | No | Enable real-time transcription (default: true) |
| `REALTIME_MODE` | No | 'mixed' for combined audio or 'individual' for per-participant (default: mixed) |
| `AUDIO_SAMPLE_RATE` | No | Audio sample rate in Hz (default: 16000) |
| `TARGET_CHUNK_DURATION_MS` | No | Audio chunk duration in milliseconds (default: 100) |

## Code Walkthrough

### 1. Initialize RTMSManager

```javascript
const rtmsConfig = {
  mediaSocketConnectionMode: process.env.MEDIA_SOCKET_CONNECTION_MODE || 'split',
  mediaTypesFlag: 1, // Audio only
  credentials: {
    meeting: {
      clientId: process.env.ZOOM_CLIENT_ID,
      clientSecret: process.env.ZOOM_CLIENT_SECRET,
      zoomSecretToken: process.env.ZOOM_SECRET_TOKEN,
    },
    // ...
  },
  mediaParams: {
    audio: {
      contentType: MEDIA_PARAMS.MEDIA_CONTENT_TYPE_RTP,
      sampleRate: MEDIA_PARAMS.AUDIO_SAMPLE_RATE_SR_16K,
      channel: MEDIA_PARAMS.AUDIO_CHANNEL_MONO,
      codec: MEDIA_PARAMS.MEDIA_PAYLOAD_TYPE_L16,
      dataOpt: MEDIA_PARAMS.MEDIA_DATA_OPTION_AUDIO_MIXED_STREAM,
      sendRate: 100,
    }
  }
};

await RTMSManager.init(rtmsConfig);
```

### 2. Set Up Webhook Handler with Meeting Lifecycle

```javascript
import { initializeAudioCollection, cleanupMeeting } from './assemblyai.js';

const webhookManager = new WebhookManager({
  config: {
    webhookPath: process.env.WEBHOOK_PATH || '/',
    zoomSecretToken: rtmsConfig.credentials.meeting.zoomSecretToken,
  },
  app: app
});

webhookManager.on('event', (event, payload) => {
  console.log('[AssemblyAI] Webhook Event:', event);

  if (event === 'meeting.rtms_started' && payload?.meeting_uuid) {
    initializeAudioCollection(payload.meeting_uuid);
  }

  if (event === 'meeting.rtms_stopped' && payload?.meeting_uuid) {
    cleanupMeeting(payload.meeting_uuid);
  }

  RTMSManager.handleEvent(event, payload);
});

webhookManager.setup();
```

### 3. Handle Audio Events

```javascript
RTMSManager.on('audio', (buffer, userId, userName, timestamp, meetingUuid, streamId, rtmsType) => {
  // Audio is handled via initializeAudioCollection per meeting
});
```

### 4. Start the Server

```javascript
await RTMSManager.start();

server.listen(appConfig.port, () => {
  console.log(`[AssemblyAI] Server listening on port ${appConfig.port}`);
});
```

## Key Files

| File | Purpose |
|------|---------|
| `index.js` | Main application entry point, sets up RTMSManager and webhook handling |
| `assemblyai.js` | AssemblyAI WebSocket streaming integration with mixed/individual modes |
| `.env.example` | Template for environment variables |
| `package.json` | Node.js dependencies |
| `recordings/` | Directory for audio recordings (if enabled) |
| `views/` | View templates (if web UI is enabled) |

## How It Works

1. When `meeting.rtms_started` webhook is received, audio collection is initialized for that meeting
2. A WebSocket connection is established to AssemblyAI's streaming endpoint
3. RTMSManager connects to the Zoom media stream and receives audio packets
4. Audio chunks are buffered and sent to AssemblyAI when they reach the target size
5. AssemblyAI returns transcription events:
   - `Begin`: Session started
   - `Turn`: Partial or final transcription (based on `turn_is_formatted`)
   - `Termination`: Session ended
6. When `meeting.rtms_stopped` is received, resources are cleaned up and connections closed

## Troubleshooting

| Issue | Solution |
|-------|----------|
| WebSocket close code 1008 | Your AssemblyAI API key is invalid or disabled |
| No transcription output | Verify `REALTIME_ENABLED=true` and API key is valid |
| Connection drops with code 1006 | Network issue; the sample auto-reconnects after 2 seconds |
| Individual mode not working | Set `REALTIME_MODE=individual` in .env |
| Webhook not received | Verify ngrok URL is configured in your Zoom app settings |

## See Also

- [RTMSManager Library Docs](../../library/README.md) - Full API reference
- [Zoom App Setup Guide](../../ZOOM_APP_SETUP.md) - Configure your Zoom app
- [Troubleshooting Guide](../../TROUBLESHOOTING.md) - Common issues
