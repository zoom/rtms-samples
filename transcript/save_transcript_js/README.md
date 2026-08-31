# Capture Zoom Meeting Transcripts with RTMS

This sample receives live Zoom meeting transcripts through RTMS and persists each stream as WebVTT, SubRip, plain text, and a canonical JSON Lines event log. It supports concurrent meetings, duplicate-event suppression, restart recovery, and configurable retention.

## Prerequisites

- Node.js 22 or newer
- A Zoom app with RTMS enabled
- Event subscriptions for `meeting.rtms_started` and `meeting.rtms_stopped`
- A public HTTPS webhook endpoint during local development

See [Zoom App Setup](../../ZOOM_APP_SETUP.md) and the [RTMSManager documentation](../../library/README.md) for the shared Marketplace and RTMS configuration.

## Setup

```bash
npm install
cp .env.example .env
node index.js
```

Configure the Marketplace webhook endpoint as your public base URL plus `WEBHOOK_PATH`, for example `https://example.ngrok.app/webhook`.

## Configuration

| Variable | Default | Purpose |
|---|---:|---|
| `ZOOM_SECRET_TOKEN` | required | Validates webhook challenges and signed deliveries |
| `ZOOM_CLIENT_ID` | required | Zoom app client ID used by RTMS |
| `ZOOM_CLIENT_SECRET` | required | Zoom app client secret used by RTMS |
| `PORT` | `3000` | HTTP server port |
| `WEBHOOK_PATH` | `/webhook` | Zoom webhook route |
| `WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS` | `300` | Maximum age of a signed webhook |
| `MEDIA_SOCKET_CONNECTION_MODE` | `split` | RTMS media socket mode |
| `TRANSCRIPT_OUTPUT_DIR` | `recordings` | Output directory, resolved from this sample folder |
| `TRANSCRIPT_RETENTION_DAYS` | `30` | Delete inactive stream folders older than this; `0` disables deletion |
| `TRANSCRIPT_CLEANUP_INTERVAL_HOURS` | `6` | Cleanup frequency; `0` disables scheduled cleanup |
| `TRANSCRIPT_DEDUP_WINDOW_EVENTS` | `10000` | Recent event fingerprints retained per active or recovered stream |

Transcript files can contain meeting content and participant names. Set retention according to your privacy and compliance requirements and restrict access to `TRANSCRIPT_OUTPUT_DIR`.

## Storage Layout

Each `rtms_stream_id` has independent timing, counters, writes, and deduplication state:

```text
recordings/
  <meeting-id-and-hash>/
    <stream-id-and-hash>/
      events.jsonl
      metadata.json
      transcript.vtt
      transcript.srt
      transcript.txt
```

The hashes prevent different IDs that sanitize to the same filesystem name from colliding. Participant names and transcript text are normalized and escaped before they are placed in VTT or SRT cues.

`events.jsonl` is the canonical append-only record. On first use after a process restart, the sample reads this log, removes an incomplete trailing record if necessary, restores the SRT counter and timing origin, restores the configured deduplication window, and rebuilds VTT/SRT/TXT. This also repairs projections left partially written by a crash.

All filesystem work uses asynchronous APIs. Events for one stream are serialized to preserve order, while separate streams can write concurrently. Duplicate fingerprints are ignored before another subtitle cue is appended.

## Webhook Security

Normal webhook deliveries are verified against the exact raw request body using `x-zm-signature`, `x-zm-request-timestamp`, and `ZOOM_SECRET_TOKEN`. Missing, invalid, or stale signatures are rejected. Verified normal deliveries receive HTTP 200 before RTMS processing begins. URL-validation challenges are signed with the same secret token.

## Testing

```bash
npm test
```

The tests cover concurrent stream isolation, VTT/SRT escaping, replay deduplication, restart recovery, and retention cleanup.

## Docker

Build from the repository root because the multi-stage Dockerfile copies the shared JavaScript library:

```bash
docker build -f transcript/save_transcript_js/Dockerfile -t rtms-save-transcript .
docker run --rm \
  --env-file transcript/save_transcript_js/.env \
  -p 3000:3000 \
  -v rtms-transcripts:/app/recordings \
  rtms-save-transcript
```

The volume is required if transcript files must survive container replacement. Runtime secrets are supplied through `--env-file` and are not copied into the image.

## Key Files

- `index.js`: HTTP server, signed webhook handling, and RTMS event wiring
- `writeTranscriptToVtt.js`: isolated asynchronous transcript storage and recovery
- `writeTranscriptToVtt.test.js`: persistence and safety tests
- `.env.example`: complete configuration template
