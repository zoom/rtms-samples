# OpenAI Realtime Assistant for Zoom Meetings

This server-side sample streams mixed Zoom meeting audio from RTMS to the OpenAI Realtime API. The realtime model can call an allowlisted set of tools on a configured remote Zoom MCP server.

The sample produces text responses only. It does not generate or play assistant audio, inject audio into a meeting, or use a Zoom App for playback.

Import [`manifest.json`](manifest.json) to create the user-managed Zoom General App. Replace the development and production domain placeholders first. The manifest declares the audio RTMS scope and the known granular scopes used by the default Zoom MCP tools. `search_zoom` can require additional entity-specific scopes, so add only the scopes needed for the entity types you enable or remove that tool from `ZOOM_MCP_ALLOWED_TOOLS`.

## Data Flow

```text
Zoom meeting
  -> RTMS mixed mono L16 audio
  -> Node.js server
  -> resample to 24 kHz PCM16
  -> OpenAI Realtime WebSocket
  -> optional remote Zoom MCP tools
  -> console text output
```

OpenAI Realtime connects directly to `ZOOM_MCP_SERVER_URL` using `ZOOM_MCP_ACCESS_TOKEN`. It does not route MCP calls through another sample in this repository.

## What The Code Does

1. `index.js` receives RTMS lifecycle events through an authenticated Zoom webhook or Zoom WebSocket event subscription.
2. `RTMSManager` opens the signaling and media connections and subscribes only to mixed audio (`mediaTypesFlag: 1`).
3. RTMS supplies mono signed 16-bit L16 audio at the configured `AUDIO_SAMPLE_RATE`; the default is 48 kHz.
4. `openaiRealtime.js` groups source audio into configured chunks and resamples it to the 24 kHz PCM16 format expected by OpenAI Realtime.
5. One OpenAI Realtime WebSocket session is maintained per active Zoom meeting.
6. OpenAI server VAD detects turns and creates text responses. Optional input transcription prints recognized meeting speech.
7. A remote MCP tool definition gives the model access to only the tools in `ZOOM_MCP_ALLOWED_TOOLS`.
8. Meeting stop and process shutdown close Realtime and RTMS connections and cancel reconnect timers.

The server prints transcripts, assistant text, MCP activity, and model-token cost estimates. Raw MCP output is disabled by default.

## Prerequisites

- Node.js and npm, or Docker
- A Zoom app with RTMS enabled
- Zoom Client ID, Client Secret, and webhook Secret Token
- An OpenAI API key with Realtime API access
- Optional: a Zoom user OAuth access token with the scopes required by the allowed Zoom MCP tools

## Configure

```bash
cp .env.example .env
```

### Zoom And RTMS

| Variable | Default | Purpose |
|---|---:|---|
| `ZOOM_SECRET_TOKEN` | required for webhook mode | Verifies Zoom webhook deliveries |
| `ZOOM_CLIENT_ID` | required | Signs RTMS signaling and media handshakes |
| `ZOOM_CLIENT_SECRET` | required | Signs RTMS signaling and media handshakes |
| `PORT` | `5050` in `.env.example` | HTTP listener port; the code falls back to `3000` when unset |
| `WEBHOOK_PATH` | `/` | Zoom webhook route |
| `WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS` | `300` | Webhook replay-protection window |
| `RTMSTRIGGERMANAGERTYPE` | `webhook` | Event source: `webhook` or `websocket` |
| `MEDIA_SOCKET_CONNECTION_MODE` | `split` | RTMS media socket mode |
| `AUDIO_SAMPLE_RATE` | `48000` | RTMS input rate: `8000`, `16000`, `32000`, or `48000` Hz |
| `TARGET_CHUNK_DURATION_MS` | `100` | Source audio represented by each OpenAI append |
| `ZOOM_S2S_CLIENT_ID` | empty | S2S credential used by shared event infrastructure when needed |
| `ZOOM_S2S_CLIENT_SECRET` | empty | S2S credential used by shared event infrastructure when needed |
| `ZOOM_ACCOUNT_ID` | empty | Zoom account used by shared event infrastructure when needed |
| `zoomWSURLForEvents` | empty | Zoom WebSocket event URL used in `websocket` mode |

Normal webhook deliveries are verified using the exact raw body, `x-zm-signature`, and `x-zm-request-timestamp`. Invalid or stale deliveries are rejected.

### OpenAI Realtime

| Variable | Default | Purpose |
|---|---:|---|
| `OPENAI_API_KEY` | required when enabled | OpenAI authentication |
| `OPENAI_REALTIME_ENABLED` | `true` | Enables the Realtime bridge |
| `OPENAI_REALTIME_MODEL` | `gpt-realtime-2` | Realtime model ID |
| `OPENAI_AUDIO_SAMPLE_RATE` | `24000` | Realtime PCM input rate; the code requires `24000` |
| `OPENAI_REALTIME_TRANSCRIPTION_ENABLED` | `true` | Enables input transcription events |
| `OPENAI_REALTIME_TRANSCRIPTION_MODEL` | `gpt-4o-mini-transcribe` | Input transcription model |
| `OPENAI_MAX_QUEUED_AUDIO_BYTES` | `2097152` | Per-meeting queued audio limit while disconnected or initializing |
| `OPENAI_REALTIME_RECONNECT_DELAY_MS` | `2000` | Delay before reconnecting an abnormal Realtime closure |
| `OPENAI_REALTIME_DEBUG_EVENTS` | `false` | Logs otherwise unhandled Realtime event types |
| `OPENAI_SAFETY_IDENTIFIER` | empty | Optional stable safety identifier sent to OpenAI |

### Zoom MCP

| Variable | Default | Purpose |
|---|---:|---|
| `ZOOM_MCP_SERVER_LABEL` | `zoom` | Label supplied to the Realtime MCP tool |
| `ZOOM_MCP_SERVER_URL` | configured in `.env.example` | Remote Zoom MCP Streamable HTTP endpoint |
| `ZOOM_MCP_ACCESS_TOKEN` | empty | User OAuth token sent to the remote MCP server |
| `ZOOM_MCP_ALLOWED_TOOLS` | built-in list | Comma-separated tool allowlist |
| `ZOOM_MCP_REQUIRE_APPROVAL` | `never` | OpenAI remote MCP approval policy |
| `OPENAI_REALTIME_LOG_RAW_MCP_OUTPUT` | `false` | Logs complete MCP output; avoid enabling with sensitive data |
| `OPENAI_REALTIME_MCP_OUTPUT_PREVIEW_CHARS` | `500` | Maximum compact MCP output preview length |

The built-in tool list is:

```text
search_meetings,search_zoom,get_meeting_assets,get_recording_resource,get_file_content,recordings_list,create_new_file_with_markdown
```

`create_new_file_with_markdown` is a write operation. Remove it from `ZOOM_MCP_ALLOWED_TOOLS` if the assistant should be read-only. The instructions permit it only after an explicit request, but an application-level approval policy is safer for production write access.

Zoom MCP access tokens expire. Production deployments should refresh user OAuth tokens securely and request only the granular scopes needed by the allowed tools.

### Cost Logging

| Variable | Default | Purpose |
|---|---:|---|
| `OPENAI_REALTIME_COST_LOGGING_ENABLED` | `true` | Prints per-response and cumulative estimates |
| `OPENAI_REALTIME_TEXT_INPUT_PRICE_PER_1M` | `4` | Text input estimate rate |
| `OPENAI_REALTIME_TEXT_OUTPUT_PRICE_PER_1M` | `24` | Text output estimate rate |
| `OPENAI_REALTIME_AUDIO_INPUT_PRICE_PER_1M` | `32` | Audio input estimate rate |
| `OPENAI_REALTIME_AUDIO_OUTPUT_PRICE_PER_1M` | `64` | Audio output estimate rate |

These are manually configured estimates based on token usage events. They do not automatically track pricing changes and do not include transcription or Zoom MCP charges.

## Run Locally

```bash
npm ci
npm start
```

For webhook mode, expose the configured port through HTTPS and configure the Zoom webhook URL to use `WEBHOOK_PATH`. For example:

```bash
ngrok http 5050
```

## Docker

Build from the `rtms-samples` repository root:

```bash
docker build \
  -f audio/send_audio_to_openai_realtime_api/Dockerfile \
  -t rtms-openai-realtime .

docker run --rm \
  --env-file audio/send_audio_to_openai_realtime_api/.env \
  -p 5050:5050 \
  rtms-openai-realtime
```

The image does not include `.env`; runtime secrets are supplied separately.

## Files

| File | Purpose |
|---|---|
| `index.js` | Express server, RTMS configuration, lifecycle events, and audio forwarding |
| `openaiRealtime.js` | Per-meeting Realtime sessions, PCM resampling, MCP configuration, response handling, and cost estimates |
| `.env.example` | Complete configuration template without credentials |
| `Dockerfile` | Multi-stage container build |
| `views/index.ejs` | Legacy Zoom App UI file; current server code does not render or serve it |

Because `views/index.ejs` is not wired into `index.js`, its controls and browser WebSocket code are inactive. There is no frontend audio player in the current sample.
