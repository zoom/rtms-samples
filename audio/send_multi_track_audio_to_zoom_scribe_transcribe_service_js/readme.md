# Send Multi-Track Audio to Zoom Scribe Live Transcription Service

Stream every Zoom RTMS participant's audio over **one** Zoom AI Services Scribe
Live WebSocket in multitrack mode, and get back transcripts attributed to the
RTMS participant who spoke, with absolute timestamps.

> Built with `RTMSManager` and Zoom AI Services Scribe live streaming.

## What This Sample Does

- Receives `meeting.rtms_started` and `meeting.rtms_stopped` events through `WebhookManager` or `WebsocketManager`.
- Requests 16 kHz mono L16 RTMS individual audio (`AUDIO_MULTI_STREAMS`): one stream per participant.
- Opens a single Scribe Live WebSocket per meeting with `audio.input_mode: "multitrack"`.
- Sends each RTMS packet as an `input_audio_buffer.append` (carrying `user_id`, `user_name` and the RTMS `timestamp`) immediately followed by the raw PCM frame.
- Lets the Scribe gateway demultiplex participants onto a small pool of transcription lanes, leased per utterance and released when the speaker falls silent.
- Prints each final utterance with the participant the gateway attributed it to and its absolute `start_time` / `end_time`.
- Keeps the session alive through silence with WebSocket pings — no synthetic audio.
- On meeting stop, sends `session.close`, waits for every lane to drain, and prints a time-sorted, participant-attributed transcript.

### Compared with the individual-audio sample

[`send_individual_audio_to_zoom_scribe_transcribe_service_js`](../send_individual_audio_to_zoom_scribe_transcribe_service_js/)
solves the same problem client-side, against the API as it existed before multitrack:

| | Individual-audio sample | This sample |
|---|---|---|
| Scribe sockets per meeting | 2–3, permanently assigned to the first speakers | 1 |
| Participants transcribed | First 2–3 to speak; the rest are excluded | Everyone — lanes are reused as people take turns |
| Who said what | Client keeps per-socket time spans and joins them to results | Gateway echoes the participant `metadata` on each result |
| Absolute times | Client converts session offsets with RTMS timestamps | Gateway returns `start_timestamp` / `end_timestamp` |
| Silence handling | Injects PCM silence every 10 s of inactivity | WebSocket ping |

## Quick Start

```bash
cd audio/send_multi_track_audio_to_zoom_scribe_transcribe_service_js
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

Run the unit tests (no Zoom credentials needed):

```bash
npm test
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
SCRIBE_LIVE_URL=wss://api.zoom.us/v2/aiservices/scribe/live
SCRIBE_LANGUAGE=en-US
SCRIBE_INPUT_MODE=multitrack
SCRIBE_WORD_TIME_OFFSETS=true
SCRIBE_DIARIZATION=false
SCRIBE_INTERIM_RESULTS=false
SCRIBE_PROFANITY_FILTER=false
SCRIBE_LOG_RAW_EVENTS=false
SCRIBE_VOCABULARY_JSON=
SCRIBE_PING_INTERVAL_MS=15000
SCRIBE_HEARTBEAT_IDLE_MS=10000
SCRIBE_HEARTBEAT_AUDIO_MS=1000
SCRIBE_RECONNECT_DELAY_MS=2000
SCRIBE_PENDING_AUDIO_MS=1500
SCRIBE_SAVE_DIARIZED_TRANSCRIPT=false
SCRIBE_TRANSCRIPT_OUTPUT_DIR=diarized_transcripts
```

| Variable | Purpose |
|---|---|
| `SCRIBE_INPUT_MODE` | `multitrack` (default) or `auto`. See [Input Modes](#input-modes). |
| `SCRIBE_DIARIZATION` | Adds Scribe's acoustic `speaker` labels beside the RTMS participant. Useful when one RTMS source is a shared room. |
| `SCRIBE_INTERIM_RESULTS` | Prints `transcription.delta` partials labeled with the participant name. |
| `SCRIBE_PING_INTERVAL_MS` | WebSocket ping cadence. Must stay well below the server's 60 s idle timeout. |
| `SCRIBE_HEARTBEAT_IDLE_MS` / `SCRIBE_HEARTBEAT_AUDIO_MS` | `auto` mode only: PCM silence sent after this much audio inactivity, until the session switches to lanes. |
| `SCRIBE_PENDING_AUDIO_MS` | Audio retained **per participant** while the socket connects or reconnects. Keep it below 2000 (see [Notes](#notes)). |
| `SCRIBE_SAVE_DIARIZED_TRANSCRIPT` | Saves the final transcript as JSON (owner-only `0600`) under `SCRIBE_TRANSCRIPT_OUTPUT_DIR`. |

### Custom Vocabulary

Set `SCRIBE_VOCABULARY_JSON` to a JSON object with any of `phrases`, `pronunciations`
and `aliases`; it is sent as `config.vocabulary`. Leave it empty to omit it.

```env
SCRIBE_VOCABULARY_JSON={"phrases":["AIAGW","Zoom AI Companion"],"pronunciations":[{"phrase":"AIAGW","pronunciation":"A I A gateway"}],"aliases":[{"canonical":"Zoom AI Companion","variants":["AI Companion","Zoom Companion"]}]}
```

## How It Works

1. The app starts an Express server and initializes RTMSManager with `AUDIO_MULTI_STREAMS`.
2. On `meeting.rtms_started`, `scribeClient.js` mints a Build-platform JWT, opens one Scribe Live WebSocket, and sends `session.update` with `audio.input_mode`.
3. RTMS delivers audio per participant. Muted and silent participants send nothing.
4. Every packet becomes an `input_audio_buffer.append` + binary pair. Audio that arrives before `session.updated` is held per participant and flushed in order once the session is ready.
5. The gateway assigns each participant who starts talking to a free lane, and returns the lane to the pool once they stop. Sequential speakers share one lane; simultaneous speakers each get one.
6. Each `transcription.completed` carries the participant `metadata` and absolute `start_timestamp` / `end_timestamp`; the sample prints it as a `transcript.utterance`.
7. Between speech, the sample pings the WebSocket so a quiet meeting is not closed as idle.
8. On `meeting.rtms_stopped`, the sample sends `session.close`, waits for the last finals from every lane, and prints `transcript.final` sorted by `start_time` — lanes finish independently, so finals arrive in completion order rather than speaking order.

## Input Modes

| `SCRIBE_INPUT_MODE` | Behavior |
|---|---|
| `multitrack` (default) | `user_id` keys lanes from the first frame. Every binary frame **must** be preceded by an append with `metadata.user_id`. WebSocket pings count as activity. |
| `auto` | One mixed timeline until two participants' audio overlaps in time, then per-participant lanes. Until that switch only audio counts as activity, so the sample also sends a short silence heartbeat when the meeting is quiet. |

`mixed` is intentionally not offered: per-participant audio overlaps whenever two
people talk at once, and a mixed session rejects that with a fatal
`concurrent_sources` error. For RTMS mixed audio (`AUDIO_MIXED_STREAM`), use
[`send_audio_to_zoom_scribe_transcribe_service_js`](../send_audio_to_zoom_scribe_transcribe_service_js/).

## Output

Each completed utterance is printed as it arrives:

```json
{
  "event": "transcript.utterance",
  "source_event": "transcription.completed",
  "meeting_uuid": "meeting-uuid",
  "item_id": "l1:seg_3",
  "participant": {
    "user_id": 16778240,
    "user_name": "User Name"
  },
  "start_time": 1788334064899,
  "end_time": 1788334067099,
  "received_time": 1788334067512,
  "text": "So I think we should ship it."
}
```

- `participant` comes from the gateway's echo of the RTMS metadata this sample sent with the audio.
- `start_time` / `end_time` are Unix epoch milliseconds on the RTMS clock, computed by the gateway. `received_time` is the local server's clock when the final arrived.
- `item_id` is prefixed with the lane (`l<n>:`). Lanes are reused across participants over a meeting, so never key on the lane — use `participant`.

**Several participants in one utterance.** If audio from more than one participant
fed a single utterance (possible in `auto` before it switches to lanes, when one
person picks up exactly as another stops), `participant` is the participant who
spoke longest and `participant_segments` lists each one:

```json
"participant_segments": [
  { "participant": { "user_id": 101, "user_name": "Alpha" }, "start_time": 1788334070000, "end_time": 1788334070800 },
  { "participant": { "user_id": 202, "user_name": "Bravo" }, "start_time": 1788334071000, "end_time": 1788334073000 }
]
```

**Diarization.** RTMS identifies the *source*; it cannot tell that a source is a
conference room with several people in it. With `SCRIBE_DIARIZATION=true`, Scribe's
acoustic label is reported **beside** the participant, never in place of it, along
with `speaker_segments` and `source_speaker_count` (how many distinct voices that
`user_id` has produced so far):

```json
"participant": { "user_id": 200, "user_name": "Conference Room" },
"speaker": "Speaker 2",
"source_speaker_count": 3
```

A count of 1 means the source behaves like one person; more means a shared device,
so show "Conference Room / Speaker 2".

## Live WebSocket Protocol

```text
Connect: wss://api.zoom.us/v2/aiservices/scribe/live
  Subprotocols: ["live-asr", "zoom-api-access-token.<Build-platform JWT>"]

Client -> {
  "type": "session.update",
  "audio": { "format": "pcm16", "input_mode": "multitrack" },
  "config": {
    "language": "en-US",
    "word_time_offsets": true,
    "diarization": false,
    "interim_results": false,
    "profanity_filter": false
  }
}

# For every RTMS audio packet, a pair -- in this order, nothing in between:
Client -> { "type": "input_audio_buffer.append",
            "metadata": { "timestamp": 1788334063359, "user_id": 16778240, "user_name": "User Name" } }
Client -> <binary PCM16 frame>

Client -> <WebSocket ping>                                     # liveness while nobody speaks
Client -> { "type": "session.close" }                          # on meeting stop

Server -> { "type": "session.created", "session_id": ... }
Server -> { "type": "session.updated", "input_mode": "multitrack", ... }
Server -> { "type": "transcription.completed", "item_id": "l0:seg_1", "transcript": ...,
            "audio_start_ms": ..., "audio_end_ms": ...,
            "start_timestamp": ..., "end_timestamp": ...,
            "metadata": { "user_id": ..., "user_name": ... } }
Server -> { "type": "error", "error": { "code": "multitrack_capacity", "fatal": false, ... } }
Server -> { "type": "session.closed", "reason": ... }          # after every lane drains
```

`metadata` is also echoed on `transcription.delta`, `input_audio_buffer.speech_started`
and `input_audio_buffer.speech_stopped`.

## Health

`GET /health` reports the active meeting's session: requested and resolved input
mode, readiness, participant count, lanes observed so far, sent / queued /
dropped audio, `multitrack_capacity` warnings, and completed utterances.

## Files

| File | Purpose |
|------|---------|
| `index.js` | Express, RTMSManager (`AUDIO_MULTI_STREAMS`), webhook/websocket trigger, forwards each participant's audio with its identity |
| `scribeClient.js` | Scribe JWT auth, the multitrack WebSocket session (paired appends, liveness, reconnects), result formatting, final transcript |
| `tests/multitrack.test.js` | Unit tests for the wire contract, attribution, liveness and reconnect behavior |
| `.env.example` | Configuration template |

## Troubleshooting

| Issue | Check |
|-------|-------|
| Missing credential error | Set `ZOOM_CLIENT_ID`, `ZOOM_CLIENT_SECRET`, `ZOOM_SECRET_TOKEN`, `ZOOM_API_KEY`, and `ZOOM_API_SECRET`. |
| No webhook received | Confirm the public HTTPS webhook URL points to `/webhook` or your configured `WEBHOOK_PATH`. |
| WebSocket 401/403 on connect | Confirm `ZOOM_API_KEY`/`ZOOM_API_SECRET` are AI Services / Build-platform credentials. |
| `CONNECTION FAILED ... session.update rejected` | The endpoint refused `audio.input_mode` (`invalid_config`). Confirm it supports multitrack. |
| `capacity_exceeded` before `session.updated` | The gateway could not reserve the extra lanes. The sample reconnects with backoff. |
| Repeated `multitrack_capacity` warnings | More people talked at once than there were free lanes, for longer than the gateway buffers; those frames were dropped. |
| `concurrent_sources` fatal error | Overlapping participant audio reached a session that was not using lanes. Use `SCRIBE_INPUT_MODE=multitrack`. |
| Session closes with `idle_timeout` in `auto` mode | Keep `SCRIBE_HEARTBEAT_IDLE_MS` well below 60 s. |

## Notes

- The sample does not run voice-activity detection. RTMS stops sending a participant's audio when they are muted or silent, and Scribe handles speech segmentation and lane release.
- The client's reconnect backlog is capped per participant at `SCRIBE_PENDING_AUDIO_MS`. The gateway holds at most about 2 s of audio for a participant waiting for a lane, so a larger backlog flushed in one burst would be dropped as `multitrack_capacity`.
- RTMS timestamps are epoch milliseconds. The client also accepts micro- or nanosecond clocks and always sends an integer; a clock it cannot recognize is omitted (the audio is still attributed, but has no absolute time).
- Audio without an RTMS `user_id` cannot be assigned to a lane and is dropped with a single warning.
- The session reconnects on abnormal closes, `503`/`429` handshake rejections (honoring `Retry-After`), fatal `capacity_exceeded`/`rate_limited`, and `server_shutting_down`, with exponential backoff up to 3 attempts. Deliberate meeting shutdown does not reconnect.
- RTMS L16 at 16 kHz mono matches the live API's `pcm16` format exactly, so audio is forwarded verbatim.

## Docker

Build and run it from the `rtms-samples` repository root:

```bash
docker build -f audio/send_multi_track_audio_to_zoom_scribe_transcribe_service_js/Dockerfile -t rtms-audio-send_multi_track_audio_to_zoom_scribe_transcribe_service_js .
docker run --rm --env-file audio/send_multi_track_audio_to_zoom_scribe_transcribe_service_js/.env -p 3000:3000 rtms-audio-send_multi_track_audio_to_zoom_scribe_transcribe_service_js
```

Run the build from the repository root because the Dockerfile uses repository-relative paths. Runtime secrets are supplied with `--env-file` and are excluded from the image build context.

## Webhook Delivery Authentication

Normal Zoom webhook deliveries are verified against the exact raw request body using
`x-zm-signature` and `x-zm-request-timestamp`. Configure `ZOOM_SECRET_TOKEN` with the
Marketplace app's webhook Secret Token. Requests with missing, invalid, or stale
signatures are rejected; the default replay window is 300 seconds and can be changed
with `WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS`.
