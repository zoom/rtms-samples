# Send Audio to Whisper Local Transcription Service

Stream Zoom meeting audio to OpenAI's Whisper model running locally for speech-to-text transcription.

> **Built with [RTMSManager](../../library/README.md)** - Zoom's JavaScript library for real-time media streaming.

## Quick Start

```bash
npm install
pip install -r requirements.txt   # Install Python dependencies
cp .env.example .env              # Fill in your credentials
node index.js
```

Expose with ngrok: `ngrok http 3000`

## What This Sample Does

This sample captures live audio from Zoom meetings and transcribes it using OpenAI's Whisper model running locally on your machine. Unlike cloud-based services, all audio processing happens on your local hardware, providing privacy and offline capability. The sample buffers audio chunks, writes them as WAV files, and processes them through Python's Whisper library.

## Prerequisites

- Node.js v18+
- Python 3.8+
- Zoom account with RTMS enabled
- OpenAI Whisper installed (`pip install openai-whisper`)
- ngrok for local development
- Sufficient CPU/GPU for model inference

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ZOOM_SECRET_TOKEN` | Yes | Your Zoom app's secret token for webhook validation |
| `ZOOM_CLIENT_ID` | Yes | Your Zoom app's client ID |
| `ZOOM_CLIENT_SECRET` | Yes | Your Zoom app's client secret |
| `PORT` | No | Server port (default: 3000) |
| `WEBHOOK_PATH` | No | Webhook endpoint path (default: /webhook) |
| `WHISPER_MODEL` | No | Whisper model size: tiny, base, small, medium, large, large-v2, large-v3 (default: tiny) |
| `WHISPER_LANGUAGE` | No | Language code (e.g., en, es, fr) or empty for auto-detect (default: en) |
| `WHISPER_CHUNK_DURATION_MS` | No | Audio chunk duration in milliseconds (default: 3000) |

## Code Walkthrough

### 1. Initialize RTMSManager

```javascript
const rtmsConfig = {
  mediaSocketConnectionMode: process.env.MEDIA_SOCKET_CONNECTION_MODE || 'split',
  mediaTypesFlag: 1,
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

await initWhisperTranscription();
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
  console.log('[Whisper] Webhook Event:', event);
  RTMSManager.handleEvent(event, payload);
});

webhookManager.setup();
```

### 3. Handle Audio Events

```javascript
import { sendAudioChunk, initWhisperTranscription, closeWhisperTranscription } from './whisper.js';

RTMSManager.on('audio', (audioEvent) => {
  const { buffer, userId, userName } = audioEvent;
  sendAudioChunk(buffer);
});
```

### 4. Start the Server

```javascript
await RTMSManager.start();

server.listen(appConfig.port, () => {
  console.log(`[Whisper] Server listening on port ${appConfig.port}`);
});
```

## Key Files

| File | Purpose |
|------|---------|
| `index.js` | Main application entry point, sets up RTMSManager and webhook handling |
| `whisper.js` | Local Whisper transcription via Python subprocess |
| `requirements.txt` | Python dependencies (openai-whisper, torch) |
| `.env.example` | Template for environment variables |
| `package.json` | Node.js dependencies |

## How It Works

1. On startup, the sample verifies Whisper is installed by running a Python check
2. When a Zoom meeting starts RTMS, the webhook receives the event and triggers RTMSManager
3. RTMSManager connects to the Zoom media stream and receives audio packets
4. Audio chunks are buffered until reaching the target duration (default: 3 seconds)
5. When a chunk is ready:
   - Raw PCM audio is written to a temporary WAV file with proper headers
   - A Python subprocess runs Whisper transcription on the WAV file
   - The transcription result is logged to the console
   - The temporary file is deleted
6. Chunks are processed sequentially through a queue to prevent overload

## Model Selection Guide

| Model | Speed | Accuracy | Memory | Use Case |
|-------|-------|----------|--------|----------|
| `tiny` | ~1s/3s audio | Basic | ~1GB | Quick testing, low-end hardware |
| `base` | ~2s/3s audio | Good | ~1GB | General use |
| `small` | ~5s/3s audio | Better | ~2GB | Production use |
| `medium` | ~10s/3s audio | High | ~5GB | High accuracy needs |
| `large-v3` | ~20s/3s audio | Best | ~10GB | Maximum accuracy |

## Troubleshooting

| Issue | Solution |
|-------|----------|
| "Whisper not properly installed" | Run `pip install -r requirements.txt` |
| "Python3 not found" | Ensure Python 3.8+ is installed and in PATH |
| Slow transcription | Use a smaller model or reduce `WHISPER_CHUNK_DURATION_MS` |
| Out of memory | Use a smaller model (tiny or base) |
| No speech detected | Verify audio is being received; try increasing chunk duration |
| Webhook not received | Verify ngrok URL is configured in your Zoom app settings |

## See Also

- [RTMSManager Library Docs](../../library/README.md) - Full API reference
- [Zoom App Setup Guide](../../ZOOM_APP_SETUP.md) - Configure your Zoom app
- [Troubleshooting Guide](../../TROUBLESHOOTING.md) - Common issues
