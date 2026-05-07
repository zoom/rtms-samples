# Send Audio to Zoom Scribe Transcription Service

Stream Zoom RTMS meeting audio into short WAV windows and transcribe each window with the Zoom AI Services Scribe API fast-mode endpoint.

> Built with `RTMSManager` and Zoom AI Services Scribe fast mode.

## What This Sample Does

- Receives `meeting.rtms_started` and `meeting.rtms_stopped` events through `WebhookManager` or `WebsocketManager`.
- Connects RTMSManager to the meeting media stream.
- Requests audio-only RTMS media as 16 kHz mono L16 mixed audio.
- Buffers RTMS PCM audio into short WAV chunks under `audio_windows/`.
- Sends each chunk to Scribe fast mode with `POST /aiservices/scribe/transcribe`.
- Logs each returned transcript to the console.

Scribe is file-oriented, not a live streaming WebSocket. This sample is a pseudo-streaming pattern: it sends one WAV chunk every `SCRIBE_WINDOW_SECONDS` seconds, waits for the fast-mode response, and then logs the returned transcript.

## Quick Start

```bash
cd audio/send_audio_to_zoom_scribe_transcribe_service_js
npm install
cp .env.example .env
```

Edit `.env`, then start the sample:

```bash
npm start
```

Expose the app over HTTPS for webhooks, for example:

```bash
ngrok http 3000
```

Set the Zoom RTMS webhook URL to:

```text
https://your-domain.example.com/webhook
```

## Required Environment Variables

```env
ZOOM_CLIENT_ID=
ZOOM_CLIENT_SECRET=
ZOOM_SECRET_TOKEN=

ZOOM_API_KEY=
ZOOM_API_SECRET=
```

`ZOOM_API_KEY` and `ZOOM_API_SECRET` are the Zoom AI Services / Build-platform credentials used to sign the Scribe JWT.

## Optional Environment Variables

```env
PORT=3000
WEBHOOK_PATH=/webhook
SCRIBE_BASE_URL=https://api.zoom.us/v2
SCRIBE_LANGUAGE=en-US
SCRIBE_WINDOW_SECONDS=10
SCRIBE_MAX_WINDOWS=24
SCRIBE_WORD_TIME_OFFSETS=true
SCRIBE_TIMESTAMPS=true
SCRIBE_DIARIZATION=false
SCRIBE_CHANNEL_SEPARATION=false
SCRIBE_PROFANITY_FILTER=false
SCRIBE_OUTPUT_FORMAT=json
```

Recommended starting window size is `10` seconds. Lower values give faster partial results but increase upload overhead and can cut words across windows.

## How It Works

1. The app starts an Express server and initializes RTMSManager.
2. The webhook endpoint receives `meeting.rtms_started`.
3. RTMSManager connects to Zoom signaling/media sockets.
4. RTMS audio packets arrive as raw 16 kHz mono PCM.
5. `audioWindowBuffer.js` wraps each `SCRIBE_WINDOW_SECONDS` window in a WAV container.
6. `scribeClient.js` signs a Build-platform JWT and submits the WAV chunk to Scribe fast mode.
7. The returned transcript text is logged as `[ZoomScribe] Transcript result`.

## Scribe Request Shape

The sample uses multipart upload:

```text
POST https://api.zoom.us/v2/aiservices/scribe/transcribe
Authorization: Bearer <Build-platform JWT>
file=<WAV file>
config={"language":"en-US","word_time_offsets":true,"timestamps":true}
```

## Files

| File | Purpose |
|------|---------|
| `index.js` | Express, RTMSManager, webhook/websocket trigger, transcription queue |
| `audioWindowBuffer.js` | Converts RTMS L16 PCM chunks into WAV windows |
| `scribeClient.js` | Zoom Scribe JWT auth and fast-mode transcription client |
| `.env.example` | Configuration template |

## Troubleshooting

| Issue | Check |
|-------|-------|
| Missing credential error | Set `ZOOM_CLIENT_ID`, `ZOOM_CLIENT_SECRET`, `ZOOM_SECRET_TOKEN`, `ZOOM_API_KEY`, and `ZOOM_API_SECRET`. |
| No webhook received | Confirm the public HTTPS webhook URL points to `/webhook` or your configured `WEBHOOK_PATH`. |
| No transcript text | Confirm RTMS is receiving audio and `audio_windows/` contains WAV files. |
| Scribe 401/403 | Confirm `ZOOM_API_KEY` and `ZOOM_API_SECRET` are AI Services / Build-platform credentials. |
| Slow updates | Lower `SCRIBE_WINDOW_SECONDS`, but expect more upload overhead. |

## Notes

- This sample uses mixed meeting audio. For per-participant audio, request RTMS audio multi-streams and route windows by RTMS `userId`.
- Scribe fast mode is best for short windows. For long recordings or archives, use Scribe batch jobs instead.
