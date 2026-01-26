# Send Audio to Deepgram Transcription Service

Stream Zoom meeting audio to Deepgram for real-time speech-to-text transcription.

> **Built with [RTMSManager](../../library/README.md)** - Zoom's JavaScript library for real-time media streaming.

## Quick Start

```bash
npm install
cp .env.example .env   # Fill in your credentials
node index.js
```

Expose with ngrok: `ngrok http 3000`

## What This Sample Does

This sample captures live audio from Zoom meetings and streams it to Deepgram's real-time transcription API. It uses Deepgram's Nova-3 model with smart formatting, punctuation, and interim results enabled. The transcription is displayed in the console as participants speak.

## Prerequisites

- Node.js v18+
- Zoom account with RTMS enabled
- Deepgram account with API key
- ngrok for local development

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ZOOM_SECRET_TOKEN` | Yes | Your Zoom app's secret token for webhook validation |
| `ZOOM_CLIENT_ID` | Yes | Your Zoom app's client ID |
| `ZOOM_CLIENT_SECRET` | Yes | Your Zoom app's client secret |
| `PORT` | No | Server port (default: 3000) |
| `WEBHOOK_PATH` | No | Webhook endpoint path (default: /webhook) |
| `DEEPGRAM_API_KEY` | Yes | Your Deepgram API key |

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
      sendRate: 20,
    }
  }
};

await RTMSManager.init(rtmsConfig);
```

### 2. Set Up Webhook Handler

```javascript
const webhookManager = new WebhookManager({
  config: {
    webhookPath: process.env.WEBHOOK_PATH || '/',
    zoomSecretToken: rtmsConfig.credentials.meeting.zoomSecretToken,
  },
  app: app
});

webhookManager.on('event', (event, payload) => {
  console.log('[Deepgram] Webhook Event:', event);
  RTMSManager.handleEvent(event, payload);
});

webhookManager.setup();
```

### 3. Handle Audio Events

```javascript
// Start Deepgram transcription connection
startDeepgramTranscription();

// Register audio handler
RTMSManager.on('audio', (event) => {
  sendAudioChunk(event.buffer);
});
```

### 4. Start the Server

```javascript
await RTMSManager.start();

server.listen(appConfig.port, () => {
  console.log(`[Deepgram] Server listening on port ${appConfig.port}`);
});
```

## Key Files

| File | Purpose |
|------|---------|
| `index.js` | Main application entry point, sets up RTMSManager and webhook handling |
| `deepgram.js` | Deepgram SDK integration with live transcription streaming |
| `.env.example` | Template for environment variables |
| `package.json` | Node.js dependencies |

## How It Works

1. The server starts and establishes a persistent WebSocket connection to Deepgram
2. When a Zoom meeting starts RTMS, the webhook receives the event and triggers RTMSManager
3. RTMSManager connects to the Zoom media stream and receives audio packets
4. Each audio chunk is forwarded to Deepgram via the WebSocket connection
5. Deepgram processes the audio and returns real-time transcription results
6. Transcriptions are logged to the console as they arrive

## Troubleshooting

| Issue | Solution |
|-------|----------|
| No transcription output | Verify your `DEEPGRAM_API_KEY` is valid and has sufficient credits |
| Connection drops | Check network stability; the sample includes auto-reconnect logic |
| Audio quality issues | Ensure `sampleRate: 16000` matches your Deepgram config |
| Webhook not received | Verify ngrok URL is configured in your Zoom app settings |

## See Also

- [RTMSManager Library Docs](../../library/README.md) - Full API reference
- [Zoom App Setup Guide](../../ZOOM_APP_SETUP.md) - Configure your Zoom app
- [Troubleshooting Guide](../../TROUBLESHOOTING.md) - Common issues
