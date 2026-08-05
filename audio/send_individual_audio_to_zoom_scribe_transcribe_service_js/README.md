# Send Individual Audio to Zoom Scribe Live Transcription Service

Route Zoom RTMS individual participant audio through a fixed pool of Zoom AI
Services Scribe Live WebSockets and label returned transcripts with RTMS names.

> Built with `RTMSManager` and Zoom AI Services Scribe live streaming.

## What This Sample Does

- Receives `meeting.rtms_started` and `meeting.rtms_stopped` events through `WebhookManager` or `WebsocketManager`.
- Connects RTMSManager to the meeting media stream.
- Requests 16 kHz mono L16 RTMS individual audio (`AUDIO_MULTI_STREAMS`).
- Opens a fixed pool of persistent Scribe Live WebSockets per active meeting.
- Locks each active participant to one slot and queues additional participants when all slots are occupied.
- Releases a slot only after a silence pause and transcript-drain check.
- Labels each returned transcript with the RTMS `userId` and `userName` recorded for that lease.
- Converts Scribe's session-relative audio offsets into epoch-millisecond `start_time` and `end_time` values using the matched RTMS audio timestamp.
- Prints a time-sorted, speaker-labeled transcript when the meeting stops.

Unlike the fast-mode `/transcribe` endpoint (which uploads whole audio files), the
live endpoint is a true streaming WebSocket: audio flows in continuously and
transcripts come back with low latency while the meeting is still in progress.

## Quick Start

```bash
cd audio/send_individual_audio_to_zoom_scribe_transcribe_service_js
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
SCRIBE_POOL_SIZE=3
SCRIBE_HEARTBEAT_IDLE_MS=10000
SCRIBE_HEARTBEAT_AUDIO_MS=1000
SCRIBE_RECONNECT_DELAY_MS=2000
SCRIBE_RELEASE_PAUSE_MS=1500
SCRIBE_DRAIN_TIMEOUT_MS=4000
SCRIBE_SWITCH_SILENCE_MS=400
SCRIBE_PARTICIPANT_QUEUE_MAX_BYTES=160000
SCRIBE_SILENCE_RMS_THRESHOLD=250
```

`SCRIBE_LIVE_URL` is the full WebSocket URL of the live transcription endpoint
(defaults to `wss://api.zoom.us/v2/aiservices/scribe/live`).

## How It Works

1. The app starts an Express server and initializes RTMSManager.
2. The webhook endpoint receives `meeting.rtms_started` and creates three Live Scribe slots.
3. RTMSManager requests individual audio; every PCM packet includes its participant identity.
4. The first packet for a participant acquires a free slot. Further packets keep the same lease.
5. A fourth simultaneous participant is buffered in a bounded FIFO waiting queue.
6. After `SCRIBE_RELEASE_PAUSE_MS` of silence, the slot waits for Scribe's `audio_end_ms` watermark. New audio during this period cancels release.
7. After `SCRIBE_HEARTBEAT_IDLE_MS` without audio, the sample sends a WebSocket ping and `SCRIBE_HEARTBEAT_AUDIO_MS` of unattributed PCM silence to keep the persistent Scribe connection active.
8. Returned transcript times are matched against the slot's immutable lease ranges and printed with the RTMS user name and calculated epoch timestamps.
9. On meeting stop, all three sessions close and the merged speaker-labeled transcript is printed.

## Pool State

`GET /health` includes each slot's state, readiness, lease ID, participant, pending
bytes, and the number of waiting participants. Slot states are `free`, `assigned`,
or `draining`.

Example transcript log:

```text
[ZoomScribePool] User Name (16778240) start_time=1785904341078 end_time=1785904343546 Hello everyone.
```

Lease IDs are used internally so delayed results are matched to historical audio
ranges rather than whichever participant currently owns the socket.

`start_time` and `end_time` are Unix epoch timestamps in milliseconds. Scribe
returns `audio_start_ms` and `audio_end_ms` relative to its WebSocket session; the
sample converts them to epoch time using the timestamp of the matching RTMS audio
packet.

## Live WebSocket Protocol

```text
Connect: wss://api.zoom.us/v2/aiservices/scribe/live
  Subprotocols: ["live-asr", "zoom-api-access-token.<Build-platform JWT>"]
  (the JWT is carried in the "zoom-api-access-token.*" subprotocol)

Client -> {
  "type": "session.update",
  "audio": { "format": "pcm16" },
  "config": {
    "language": "en-US",
    "word_time_offsets": true,
    "channel_separation": false,
    "diarization": false,
    "profanity_filter": false,
    "output_format": "json"
  }
}
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
| `scribeClient.js` | Three-slot Scribe pool, participant leases, queueing, attribution, and cleanup |
| `.env.example` | Configuration template |

## Troubleshooting

| Issue | Check |
|-------|-------|
| Missing credential error | Set `ZOOM_CLIENT_ID`, `ZOOM_CLIENT_SECRET`, `ZOOM_SECRET_TOKEN`, `ZOOM_API_KEY`, and `ZOOM_API_SECRET`. |
| No webhook received | Confirm the public HTTPS webhook URL points to `/webhook` or your configured `WEBHOOK_PATH`. |
| WebSocket 401/403 on connect | Confirm `ZOOM_API_KEY`/`ZOOM_API_SECRET` are AI Services / Build-platform credentials. |
| Connects but no transcripts | Check `/health` for slot readiness and confirm `session.updated` appears for all three slots. |
| Idle sockets close with code `1006` | Keep `SCRIBE_HEARTBEAT_IDLE_MS` below the observed idle cutoff. The default is 10 seconds and sends both a WebSocket ping and silence audio. |
| Waiting audio is dropped | Increase `SCRIBE_PARTICIPANT_QUEUE_MAX_BYTES` or increase the pool size within your Live Scribe concurrency allowance. |

## Notes

- This sample keeps `SCRIBE_DIARIZATION=false` and `SCRIBE_CHANNEL_SEPARATION=false`; speaker identity comes from RTMS.
- Silent PCM packets do not acquire slots or reset the release pause. Adjust `SCRIBE_SILENCE_RMS_THRESHOLD` for unusually quiet or noisy input.
- The Scribe heartbeat combines a WebSocket ping with silence audio so both transport and application-level activity occur. Heartbeat audio is not attributed to any participant.
- The three sockets are shared over time, but a socket never carries two participant leases simultaneously.
- A short PCM silence boundary is inserted when a slot changes participants to reduce cross-lease transcript segments.
- Server-initiated WebSocket closures, including close code `1000`, are reconnected after `SCRIBE_RECONNECT_DELAY_MS`. Deliberate meeting shutdown does not reconnect.
- RTMS L16 at 16 kHz mono matches the live API's required `pcm16` format exactly, so audio is forwarded verbatim with no resampling or WAV wrapping.
