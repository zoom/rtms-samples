# Send Audio to AWS Transcribe Service

Stream Zoom meeting audio to AWS Transcribe for real-time speech-to-text transcription.

> **Built with [RTMSManager](../../library/README.md)** - Zoom's JavaScript library for real-time media streaming.

## Quick Start

```bash
npm install
cp .env.example .env   # Fill in your credentials
node index.js
```

Expose with ngrok: `ngrok http 5050`

## What This Sample Does

This sample captures live audio from Zoom meetings and streams it to AWS Transcribe Streaming. It uses the AWS SDK to establish a bidirectional streaming connection, sending audio chunks and receiving transcription results in real-time. Final transcriptions are displayed in the console as participants speak.

## Prerequisites

- Node.js v18+
- Zoom account with RTMS enabled
- AWS account with Transcribe access
- AWS IAM credentials with `transcribe:StartStreamTranscription` permission
- ngrok for local development

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ZOOM_SECRET_TOKEN` | Yes | Your Zoom app's secret token for webhook validation |
| `ZOOM_CLIENT_ID` | Yes | Your Zoom app's client ID |
| `ZOOM_CLIENT_SECRET` | Yes | Your Zoom app's client secret |
| `PORT` | No | Server port (default: 5050) |
| `WEBHOOK_PATH` | No | Webhook endpoint path (default: /) |
| `AWS_ACCESS_KEY_ID` | Yes | Your AWS access key ID |
| `AWS_SECRET_ACCESS_KEY` | Yes | Your AWS secret access key |
| `AWS_REGION` | No | AWS region for Transcribe (default: us-east-1) |
| `LANGUAGE_CODE` | No | Language code for transcription (default: en-US) |

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
      contentType: MEDIA_PARAMS.MEDIA_CONTENT_TYPE_RAW_AUDIO,
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
  console.log('[AWS Transcribe] Webhook Event:', event);
  RTMSManager.handleEvent(event, payload);
});

webhookManager.setup();
```

### 3. Handle Audio Events

```javascript
import { feedAudioData } from "./awsTranscribeToText.js";

RTMSManager.on('audio', (event) => {
  feedAudioData(event.buffer);
});
```

### 4. Start the Server

```javascript
await RTMSManager.start();

server.listen(appConfig.port, () => {
  console.log(`[AWS Transcribe] Server listening on port ${appConfig.port}`);
});
```

## Key Files

| File | Purpose |
|------|---------|
| `index.js` | Main application entry point, sets up RTMSManager and webhook handling |
| `awsTranscribeToText.js` | AWS Transcribe Streaming SDK integration |
| `.env.example` | Template for environment variables |
| `package.json` | Node.js dependencies |

## How It Works

1. The server starts and waits for audio data before connecting to AWS Transcribe
2. When a Zoom meeting starts RTMS, the webhook receives the event and triggers RTMSManager
3. RTMSManager connects to the Zoom media stream and receives audio packets
4. On first audio chunk, AWS Transcribe streaming is initialized with `StartStreamTranscriptionCommand`
5. Audio is fed through a PassThrough stream and converted to AudioEvent format
6. AWS Transcribe returns partial and final transcription results
7. Final transcriptions (non-partial) are logged to the console

## Troubleshooting

| Issue | Solution |
|-------|----------|
| "security token" or "credentials" error | Verify `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` are correct |
| No transcription output | Check AWS region supports Transcribe Streaming and language code is valid |
| Stream closed prematurely | This is handled gracefully; check for credential or permission issues |
| Webhook not received | Verify ngrok URL is configured in your Zoom app settings |

## See Also

- [RTMSManager Library Docs](../../library/README.md) - Full API reference
- [Zoom App Setup Guide](../../ZOOM_APP_SETUP.md) - Configure your Zoom app
- [Troubleshooting Guide](../../TROUBLESHOOTING.md) - Common issues
