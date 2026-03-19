# Send Audio to Local Whisper Transcription Service

Stream Zoom meeting audio to a locally running OpenAI Whisper model for real-time speech-to-text transcription.

> **Built with [RTMSManager](../../library/README.md)** - Zoom's JavaScript library for real-time media streaming.

## Quick Start

```bash
npm install
pip install -r requirements.txt
cp .env.example .env   # Fill in your credentials
node index.js
```

Expose with ngrok: `ngrok http 3000`

## What This Sample Does

This sample captures live audio from Zoom meetings and transcribes it using OpenAI's Whisper model running locally on your machine. Audio is accumulated into chunks (default: 3 seconds), written to temporary WAV files, and processed by Whisper via Python subprocess. No external API keys are required for the transcription itself—just your Zoom credentials.

## Prerequisites

- Node.js v18+
- Python 3.8+
- FFmpeg installed and accessible in PATH
- Zoom account with RTMS enabled
- ngrok for local development

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ZOOM_SECRET_TOKEN` | Yes | Your Zoom app's secret token for webhook validation |
| `ZOOM_CLIENT_ID` | Yes | Your Zoom app's client ID |
| `ZOOM_CLIENT_SECRET` | Yes | Your Zoom app's client secret |
| `PORT` | No | Server port (default: 3000) |
| `WEBHOOK_PATH` | No | Webhook endpoint path (default: /) |
| `WHISPER_MODEL` | No | Whisper model size: tiny, base, small, medium, large (default: tiny) |
| `WHISPER_LANGUAGE` | No | Language code, e.g., en, es, fr (default: en) |
| `WHISPER_CHUNK_DURATION_MS` | No | Audio chunk duration in milliseconds (default: 3000) |

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
  console.log('[Whisper] Webhook Event:', event);
  RTMSManager.handleEvent(event, payload);
});

webhookManager.setup();
```

### 3. Handle Audio Events

```javascript
import { sendAudioChunk } from './whisper.js';

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
| `whisper.js` | Whisper integration with audio chunking and Python subprocess calls |
| `requirements.txt` | Python dependencies (openai-whisper) |
| `.env.example` | Template for environment variables |
| `package.json` | Node.js dependencies |

## How It Works

1. The server starts and waits for Zoom webhook events
2. When a meeting starts RTMS, RTMSManager connects to the Zoom media stream
3. Audio packets are accumulated into chunks (default: 3 seconds)
4. Each chunk is written to a temporary WAV file
5. Whisper is invoked via Python subprocess to transcribe the audio
6. Transcription results are logged to the console
7. Temporary files are cleaned up after processing

## Whisper Model Options

| Model | Size | Speed | Memory | Best For |
|-------|------|-------|--------|----------|
| tiny | 39 MB | ~32x | ~1 GB | Testing, low-latency |
| base | 74 MB | ~16x | ~1 GB | Basic transcription |
| small | 244 MB | ~6x | ~2 GB | Good accuracy |
| medium | 769 MB | ~2x | ~5 GB | High accuracy |
| large | 1550 MB | 1x | ~10 GB | Best accuracy |

For real-time transcription on CPU, `tiny` or `base` models are recommended.

## Troubleshooting

| Issue | Solution |
|-------|----------|
| No transcription output | Verify Whisper is installed: `python3 -c "import whisper"` |
| Whisper installation fails | Run `pip install --upgrade pip` then `pip install openai-whisper` |
| "No module named 'whisper'" | Ensure Whisper is installed in the same Python environment Node.js uses |
| FFmpeg not found | Install FFmpeg and ensure it's in your PATH |
| Slow transcription | Use a smaller model (tiny) or increase `WHISPER_CHUNK_DURATION_MS` |
| Webhook not received | Verify ngrok URL is configured in your Zoom app settings |

## See Also

- [RTMSManager Library Docs](../../library/README.md) - Full API reference
- [Zoom App Setup Guide](../../ZOOM_APP_SETUP.md) - Configure your Zoom app
- [Troubleshooting Guide](../../TROUBLESHOOTING.md) - Common issues
