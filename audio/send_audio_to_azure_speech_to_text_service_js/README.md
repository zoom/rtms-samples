# Send Audio to Azure Speech-to-Text Service

Stream Zoom meeting audio to Azure Cognitive Services for real-time speech-to-text transcription.

> **Built with [RTMSManager](../../library/README.md)** - Zoom's JavaScript library for real-time media streaming.

## Quick Start

```bash
npm install
cp .env.example .env   # Fill in your credentials
node index.js
```

Expose with ngrok: `ngrok http 3000`

## What This Sample Does

This sample captures live audio from Zoom meetings and streams it to Azure Cognitive Services Speech-to-Text. It uses the Microsoft Speech SDK with continuous recognition, providing both partial (interim) and final transcription results. The sample uses a push stream to feed audio data to the recognizer.

## Prerequisites

- Node.js v18+
- Zoom account with RTMS enabled
- Azure account with Speech Services resource
- Azure Speech subscription key and region
- ngrok for local development

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ZOOM_SECRET_TOKEN` | Yes | Your Zoom app's secret token for webhook validation |
| `ZOOM_CLIENT_ID` | Yes | Your Zoom app's client ID |
| `ZOOM_CLIENT_SECRET` | Yes | Your Zoom app's client secret |
| `PORT` | No | Server port (default: 3000) |
| `WEBHOOK_PATH` | No | Webhook endpoint path (default: /webhook) |
| `AZURE_SPEECH_KEY` | Yes | Your Azure Speech subscription key |
| `AZURE_REGION` | Yes | Azure region (e.g., southeastasia, eastus) |

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
  console.log('[Azure Speech] Webhook Event:', event);
  RTMSManager.handleEvent(event, payload);
});

webhookManager.setup();
```

### 3. Handle Audio Events

```javascript
import { azureSpeechToTextStream } from "./azureSpeechToText.js";

RTMSManager.on('audio', (event) => {
  azureSpeechToTextStream(event.buffer);
});
```

### 4. Start the Server

```javascript
await RTMSManager.start();

server.listen(appConfig.port, () => {
  console.log(`[Azure Speech] Server listening on port ${appConfig.port}`);
});
```

## Key Files

| File | Purpose |
|------|---------|
| `index.js` | Main application entry point, sets up RTMSManager and webhook handling |
| `azureSpeechToText.js` | Azure Cognitive Services Speech SDK integration |
| `.env.example` | Template for environment variables |
| `package.json` | Node.js dependencies |

## How It Works

1. On startup, the sample initializes Azure Speech SDK with a push stream and starts continuous recognition
2. When a Zoom meeting starts RTMS, the webhook receives the event and triggers RTMSManager
3. RTMSManager connects to the Zoom media stream and receives audio packets
4. Each audio chunk is written to the Azure push stream
5. The Speech recognizer processes audio and emits events:
   - `recognizing`: Partial results as speech is being recognized
   - `recognized`: Final results when speech segment completes
6. Both partial and final transcriptions are logged to the console

## Troubleshooting

| Issue | Solution |
|-------|----------|
| "AZURE_SPEECH_KEY and AZURE_REGION are required" | Ensure both environment variables are set |
| Recognition canceled with error | Check your subscription key and region are valid |
| No speech recognized | Verify audio is being received; check microphone permissions in Zoom |
| Session stopped unexpectedly | Check Azure service quotas and network connectivity |
| Webhook not received | Verify ngrok URL is configured in your Zoom app settings |

## See Also

- [RTMSManager Library Docs](../../library/README.md) - Full API reference
- [Zoom App Setup Guide](../../ZOOM_APP_SETUP.md) - Configure your Zoom app
- [Troubleshooting Guide](../../TROUBLESHOOTING.md) - Common issues

## Docker

The project forwards RTMS audio to Azure Speech to Text. Its multi-stage Dockerfile keeps build tooling out of the final runtime image and does not hard-code a CPU architecture.

Build and run it from the `rtms-samples` repository root:

```bash
docker build -f audio/send_audio_to_azure_speech_to_text_service_js/Dockerfile -t rtms-audio-send_audio_to_azure_speech_to_text_service_js .
docker run --rm --env-file audio/send_audio_to_azure_speech_to_text_service_js/.env -p 3000:3000 rtms-audio-send_audio_to_azure_speech_to_text_service_js
```

Run the build from the repository root because the Dockerfile uses repository-relative paths. Runtime secrets are supplied with `--env-file` and are excluded from the image build context.

## Webhook Delivery Authentication

Normal Zoom webhook deliveries are verified against the exact raw request body using
`x-zm-signature` and `x-zm-request-timestamp`. Configure `ZOOM_SECRET_TOKEN` with the
Marketplace app's webhook Secret Token. Requests with missing, invalid, or stale
signatures are rejected; the default replay window is 300 seconds and can be changed
with `WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS`.
