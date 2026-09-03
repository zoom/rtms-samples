# Send Individual Audio to Zoom Scribe Live Transcription Service

Route selected Zoom RTMS individual participant audio through sticky Zoom AI
Services Scribe Live WebSockets and label returned transcripts with RTMS names.

> Built with `RTMSManager` and Zoom AI Services Scribe live streaming.

## What This Sample Does

- Receives `meeting.rtms_started` and `meeting.rtms_stopped` events through `WebhookManager` or `WebsocketManager`.
- Connects RTMSManager to the meeting media stream.
- Requests 16 kHz mono L16 RTMS individual audio (`AUDIO_MULTI_STREAMS`).
- Opens two persistent Scribe Live WebSockets per active meeting.
- Permanently locks the first two participant audio streams to those sockets.
- Optionally opens a third socket only when a third participant produces audio.
- Does not queue or transcribe participants beyond the configured capacity.
- Labels each returned transcript with the RTMS `userId` and `userName` recorded for that lease.
- Converts Scribe's session-relative audio offsets into epoch-millisecond `start_time` and `end_time` values using the matched RTMS audio timestamp.
- Prints named utterances as they complete and a time-sorted, participant-attributed transcript when the meeting stops.

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
SCRIBE_VOCABULARY_JSON=
SCRIBE_POOL_SIZE=3
SCRIBE_HEARTBEAT_IDLE_MS=10000
SCRIBE_HEARTBEAT_AUDIO_MS=1000
SCRIBE_RECONNECT_DELAY_MS=2000
SCRIBE_PENDING_AUDIO_MAX_BYTES=160000
SCRIBE_SAVE_DIARIZED_TRANSCRIPT=false
SCRIBE_TRANSCRIPT_OUTPUT_DIR=diarized_transcripts
```

`SCRIBE_LIVE_URL` is the full WebSocket URL of the live transcription endpoint
(defaults to `wss://api.zoom.us/v2/aiservices/scribe/live`).

`SCRIBE_POOL_SIZE` accepts `2` or `3`. Two sockets always connect when the RTMS
meeting starts. A configured capacity of `3` permits one additional socket to be
created lazily for the third participant.

Set `SCRIBE_SAVE_DIARIZED_TRANSCRIPT=true` to save the final named transcript as
JSON when a meeting stops. `SCRIBE_TRANSCRIPT_OUTPUT_DIR` can be absolute or
relative to this sample folder and defaults to `diarized_transcripts`. Generated
files use owner-only permissions (`0600`), and the default output directory is
excluded from Git.

### Custom Vocabulary

Set `SCRIBE_VOCABULARY_JSON` to bias Live Scribe toward product names, acronyms,
and domain-specific terms. It accepts the ASR vocabulary object with optional
`phrases`, `pronunciations`, and `aliases` arrays:

```env
SCRIBE_VOCABULARY_JSON={"phrases":["AIAGW","Zoom AI Companion","ServiceNow"],"pronunciations":[{"phrase":"AIAGW","pronunciation":"A I A gateway"}],"aliases":[{"canonical":"Zoom AI Companion","variants":["AI Companion","Zoom Companion"]}]}
```

The sample validates this JSON during startup and includes it under
`session.update.config.vocabulary`. Leave the value empty to omit vocabulary
configuration. Vocabulary improves recognition bias but does not replace the
RTMS `user_id` and `user_name` attribution used for named diarization.

## How It Works

1. The app starts an Express server and initializes RTMSManager.
2. The webhook endpoint receives `meeting.rtms_started` and connects two Live Scribe sockets.
3. RTMSManager requests individual audio; every PCM packet includes its participant identity.
4. The first two participant streams permanently acquire the two connected sockets.
5. With `SCRIBE_POOL_SIZE=3`, the first audio packet from a third participant creates and permanently acquires a third socket.
6. Additional participants are excluded from Scribe transcription for that meeting and their audio is not queued.
7. Audio received while an assigned socket connects or reconnects is retained up to `SCRIBE_PENDING_AUDIO_MAX_BYTES`; the oldest pending audio is dropped if that limit is exceeded.
8. After `SCRIBE_HEARTBEAT_IDLE_MS` without audio, the sample sends a WebSocket ping and `SCRIBE_HEARTBEAT_AUDIO_MS` of unattributed PCM silence to keep the persistent Scribe connection active.
9. Returned transcript times are matched against the permanent assignment's audio ranges and printed with the RTMS user name and calculated epoch timestamps.
10. On meeting stop, all connected Scribe sessions close and the merged speaker-labeled transcript is printed.

## Pool State

`GET /health` includes configured capacity, connected socket count, excluded
participant count, and each socket's readiness, assignment, and pending bytes.
Socket states are `free` or `assigned`.

Example transcript log:

```json
{
  "event": "transcript.utterance",
  "source_event": "transcription.completed",
  "meeting_uuid": "meeting-uuid",
  "participant": {
    "user_id": 16778240,
    "user_name": "User Name"
  },
  "start_time": 1785904341078,
  "end_time": 1785904343546,
  "received_time": 1785904344012,
  "text": "Hello everyone."
}
```

This sample performs named diarization through RTMS participant attribution. It
does not expose synthetic labels such as `Speaker 1`: every utterance carries the
stable RTMS `user_id` and the participant's current `user_name`. At meeting end,
the sample prints `transcript.final` with the same records sorted under an
`utterances` array.

When file persistence is enabled, the complete `transcript.final` JSON document
is written after the Live Scribe sockets finish closing. No file is created when
the meeting produced no completed utterances.

Lease IDs are used only internally so delayed results are matched to historical
audio ranges rather than whichever participant currently owns the socket.

`start_time` and `end_time` are Unix epoch timestamps in milliseconds. Scribe
returns `audio_start_ms` and `audio_end_ms` relative to its WebSocket session; the
sample converts them to epoch time using the timestamp of the matching RTMS audio
packet. `received_time` is the local server's Unix epoch timestamp in milliseconds
when the completed transcript message is received from Live Scribe.
`source_event` records the actual Zoom Live Scribe event used to produce the
utterance. Live Scribe completion is represented by the
`transcription.completed` event type, so the normalized schema does not invent an
`is_final` field.

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
    "output_format": "json",
    "vocabulary": {
      "phrases": ["AIAGW", "Zoom AI Companion"],
      "pronunciations": [
        { "phrase": "AIAGW", "pronunciation": "A I A gateway" }
      ],
      "aliases": [
        {
          "canonical": "Zoom AI Companion",
          "variants": ["AI Companion", "Zoom Companion"]
        }
      ]
    }
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
| `scribeClient.js` | Two eager sockets, optional lazy third socket, sticky participant assignment, attribution, and cleanup |
| `.env.example` | Configuration template |

## Troubleshooting

| Issue | Check |
|-------|-------|
| Missing credential error | Set `ZOOM_CLIENT_ID`, `ZOOM_CLIENT_SECRET`, `ZOOM_SECRET_TOKEN`, `ZOOM_API_KEY`, and `ZOOM_API_SECRET`. |
| No webhook received | Confirm the public HTTPS webhook URL points to `/webhook` or your configured `WEBHOOK_PATH`. |
| WebSocket 401/403 on connect | Confirm `ZOOM_API_KEY`/`ZOOM_API_SECRET` are AI Services / Build-platform credentials. |
| Connects but no transcripts | Check `/health` for socket readiness and confirm `session.updated` appears for each connected socket. |
| Idle sockets close with code `1006` | Keep `SCRIBE_HEARTBEAT_IDLE_MS` below the observed idle cutoff. The default is 10 seconds and sends both a WebSocket ping and silence audio. |
| Participant is not transcribed | Only the first two participants, plus an optional third when `SCRIBE_POOL_SIZE=3`, receive permanent Scribe assignments. |
| Audio is dropped during reconnect | Increase `SCRIBE_PENDING_AUDIO_MAX_BYTES`. This buffer applies only to already assigned participants. |

## Notes

- This sample keeps `SCRIBE_DIARIZATION=false` and `SCRIBE_CHANNEL_SEPARATION=false`; named participant attribution comes from RTMS rather than acoustic speaker labels.
- The sample does not inspect PCM amplitude or run local voice-activity detection. Live Scribe handles speech segmentation.
- The Scribe heartbeat combines a WebSocket ping with silence audio so both transport and application-level activity occur. Heartbeat audio is not attributed to any participant.
- Participant assignments are permanent for the meeting. Sockets are not released, shared, or reassigned.
- Assignment is based on the order in which participant audio first arrives. In a two-person meeting this is normally the host and the other participant, but the code does not infer or prioritize the host role.
- Server-initiated WebSocket closures, including close code `1000`, are reconnected after `SCRIBE_RECONNECT_DELAY_MS`. Deliberate meeting shutdown does not reconnect.
- RTMS L16 at 16 kHz mono matches the live API's required `pcm16` format exactly, so audio is forwarded verbatim with no resampling or WAV wrapping.

## Docker

The project assigns individual participant audio to pooled Zoom Scribe Live sessions. Its multi-stage Dockerfile keeps build tooling out of the final runtime image and does not hard-code a CPU architecture.

Build and run it from the `rtms-samples` repository root:

```bash
docker build -f audio/send_individual_audio_to_zoom_scribe_transcribe_service_js/Dockerfile -t rtms-audio-send_individual_audio_to_zoom_scribe_transcribe_service_js .
docker run --rm --env-file audio/send_individual_audio_to_zoom_scribe_transcribe_service_js/.env -p 3000:3000 rtms-audio-send_individual_audio_to_zoom_scribe_transcribe_service_js
```

Run the build from the repository root because the Dockerfile uses repository-relative paths. Runtime secrets are supplied with `--env-file` and are excluded from the image build context.

## Webhook Delivery Authentication

Normal Zoom webhook deliveries are verified against the exact raw request body using
`x-zm-signature` and `x-zm-request-timestamp`. Configure `ZOOM_SECRET_TOKEN` with the
Marketplace app's webhook Secret Token. Requests with missing, invalid, or stale
signatures are rejected; the default replay window is 300 seconds and can be changed
with `WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS`.
