# Send Audio to Zoom Scribe Live Transcription Service

Stream Zoom RTMS meeting audio into the Zoom AI Services Scribe **live** API — a
real-time transcription WebSocket — and log transcripts as they arrive.

> Built with `RTMSManager` and Zoom AI Services Scribe live streaming.

## What This Sample Does

- Receives `meeting.rtms_started` and `meeting.rtms_stopped` events through `WebhookManager` or `WebsocketManager`.
- Connects RTMSManager to the meeting media stream.
- Requests audio-only RTMS media as 16 kHz mono L16 mixed audio.
- On `meeting.rtms_started`, opens a Scribe **live** WebSocket (`/aiservices/scribe/live`).
- Forwards each RTMS PCM packet straight to the WebSocket as a binary frame (no file buffering, no resampling).
- Logs `transcription.completed` events as they stream back.
- On `meeting.rtms_stopped`, sends `session.close`, waits for the final transcript, and closes the socket.

Unlike the fast-mode `/transcribe` endpoint (which uploads whole audio files), the
live endpoint is a true streaming WebSocket: audio flows in continuously and
transcripts come back with low latency while the meeting is still in progress.

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

`ZOOM_API_KEY` and `ZOOM_API_SECRET` are the Zoom AI Services / Build-platform credentials used to sign the Scribe JWT (the same credential the fast-mode endpoint used).

## Optional Environment Variables

```env
PORT=3000
WEBHOOK_PATH=/webhook
SCRIBE_LIVE_URL=wss://api.zoom.us/v2/aiservices/scribe/live
SCRIBE_LANGUAGE=en-US
SCRIBE_WORD_TIME_OFFSETS=true
SCRIBE_TIMESTAMPS=true
SCRIBE_DIARIZATION=false
SCRIBE_CHANNEL_SEPARATION=false
SCRIBE_PROFANITY_FILTER=false
SCRIBE_OUTPUT_FORMAT=json
```

`SCRIBE_LIVE_URL` is the full WebSocket URL of the live transcription endpoint
(defaults to `wss://api.zoom.us/v2/aiservices/scribe/live`).

## How It Works

1. The app starts an Express server and initializes RTMSManager.
2. The webhook endpoint receives `meeting.rtms_started`.
3. `scribeClient.js` mints a Build-platform JWT and opens `wss://.../aiservices/scribe/live`, then sends `session.update` (`audio.format=pcm16`, `language`).
4. RTMSManager connects to Zoom signaling/media sockets; RTMS audio arrives as raw 16 kHz mono PCM16.
5. Each audio packet is forwarded to the WebSocket as a binary frame. Audio that arrives before the session is ready is buffered and flushed on `session.updated`.
6. The server streams back `transcription.completed` events, which are logged.
7. On `meeting.rtms_stopped`, the client sends `session.close`, waits briefly for the final transcript, logs the full meeting transcript, and closes.

## Live WebSocket Protocol

```text
Connect: wss://api.zoom.us/v2/aiservices/scribe/live
  Subprotocols: ["live-asr", "zoom-api-access-token.<Build-platform JWT>"]
  (the JWT is carried in the "zoom-api-access-token.*" subprotocol)

Client -> { "type": "session.update", "audio": { "format": "pcm16" }, "language": "en-US" }
Client -> <binary PCM16 frames>                       # streamed RTMS audio
Client -> { "type": "session.close" }                 # on meeting stop

Server -> { "type": "session.created", "session_id": ... }
Server -> { "type": "session.updated" }               # ready to receive audio
Server -> { "type": "transcription.completed", "transcript": ..., "audio_start_ms": ..., "audio_end_ms": ... }
Server -> { "type": "session.closed", "reason": ... }
```

## Files

| File | Purpose |
|------|---------|
| `index.js` | Express, RTMSManager, webhook/websocket trigger, forwards RTMS audio to the live client |
| `scribeClient.js` | Scribe JWT auth + live streaming WebSocket client (connect, stream, event handling, cleanup) |
| `.env.example` | Configuration template |

## Troubleshooting

| Issue | Check |
|-------|-------|
| Missing credential error | Set `ZOOM_CLIENT_ID`, `ZOOM_CLIENT_SECRET`, `ZOOM_SECRET_TOKEN`, `ZOOM_API_KEY`, and `ZOOM_API_SECRET`. |
| No webhook received | Confirm the public HTTPS webhook URL points to `/webhook` or your configured `WEBHOOK_PATH`. |
| WebSocket 401/403 on connect | Confirm `ZOOM_API_KEY`/`ZOOM_API_SECRET` are AI Services / Build-platform credentials. |
| Connects but no transcripts | Confirm RTMS is delivering audio (watch the `chunks=`/`sentBytes=` log line) and that `session.updated` was received. |

## Notes

- This sample uses mixed meeting audio. For per-participant audio, request RTMS audio multi-streams and open one live session per RTMS `userId`.
- The live session has a server-side maximum duration; very long meetings may be closed by the server (the client logs `session.closed` with the reason). For archival transcription of long recordings, use Scribe batch jobs instead.
- RTMS L16 at 16 kHz mono matches the live API's required `pcm16` format exactly, so audio is forwarded verbatim with no resampling or WAV wrapping.
