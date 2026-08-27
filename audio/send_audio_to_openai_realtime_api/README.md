# Send Audio to OpenAI Realtime API

Stream Zoom RTMS meeting audio to the OpenAI Realtime API and give the realtime model access to Zoom's remote MCP server.

This sample is based on the existing audio forwarding samples in this repository. It keeps the RTMS webhook/media flow, replaces the downstream transcription service with OpenAI Realtime, and configures a remote Zoom MCP tool instead of the Kanban function tools from `openai/openai-realtime-meeting-assistant`.

## Quick Start

```bash
npm install
cp .env.example .env
npm start
```

Expose the local server if needed:

```bash
ngrok http 5050
```

## What This Sample Does

1. Receives Zoom `meeting.rtms_started` and `meeting.rtms_stopped` events.
2. Subscribes to mixed RTMS audio as mono L16. The default is 48 kHz because Zoom RTMS does not expose a native 24 kHz enum.
3. Resamples audio to 24 kHz mono PCM16 for OpenAI Realtime.
4. Streams audio to `gpt-realtime-2` over WebSocket.
5. Configures the Realtime session for text-only responses.
6. Registers Zoom MCP as a remote MCP tool so the model can call Zoom search/retrieval tools when meeting audio asks for it.

The sample does not generate assistant audio. It logs transcripts, text responses, MCP tool calls, MCP outputs, and usage events to the console.

Example usage/cost log:

```text
[OpenAI Realtime] Response done usage input=1234 output=80 audioIn=600 textIn=634 audioOut=0 textOut=80 cachedIn=0 estimatedCost=$0.021 cumulativeEstimatedCost=$0.067
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ZOOM_SECRET_TOKEN` | Yes | Zoom webhook secret token |
| `ZOOM_CLIENT_ID` | Yes | Zoom app client ID |
| `ZOOM_CLIENT_SECRET` | Yes | Zoom app client secret |
| `PORT` | No | Server port, default `5050` |
| `WEBHOOK_PATH` | No | Webhook path, default `/` |
| `OPENAI_API_KEY` | Yes | OpenAI API key |
| `OPENAI_REALTIME_MODEL` | No | Realtime model, default `gpt-realtime-2` |
| `OPENAI_AUDIO_SAMPLE_RATE` | No | OpenAI PCM sample rate, must be `24000` |
| `OPENAI_REALTIME_TRANSCRIPTION_ENABLED` | No | Enable async input transcription logs, default `true` |
| `OPENAI_REALTIME_TRANSCRIPTION_MODEL` | No | Transcription model, default `gpt-4o-mini-transcribe` |
| `OPENAI_REALTIME_COST_LOGGING_ENABLED` | No | Log per-response and per-meeting model token cost estimates, default `true` |
| `OPENAI_REALTIME_TEXT_INPUT_PRICE_PER_1M` | No | Text input token price used for estimates, default `4` |
| `OPENAI_REALTIME_TEXT_OUTPUT_PRICE_PER_1M` | No | Text output token price used for estimates, default `24` |
| `OPENAI_REALTIME_AUDIO_INPUT_PRICE_PER_1M` | No | Audio input token price used for estimates, default `32` |
| `OPENAI_REALTIME_AUDIO_OUTPUT_PRICE_PER_1M` | No | Audio output token price used for estimates, default `64` |
| `ZOOM_MCP_SERVER_URL` | Yes | Zoom MCP server URL |
| `ZOOM_MCP_ACCESS_TOKEN` | Yes | Zoom user OAuth token for MCP |
| `ZOOM_MCP_ALLOWED_TOOLS` | No | Comma-separated MCP tool allowlist |
| `ZOOM_MCP_REQUIRE_APPROVAL` | No | MCP approval policy, default `never` |
| `OPENAI_REALTIME_LOG_RAW_MCP_OUTPUT` | No | Log raw MCP payloads for debugging, default `false` |
| `OPENAI_REALTIME_MCP_OUTPUT_PREVIEW_CHARS` | No | Max preview length for compact MCP log summaries, default `500` |
| `AUDIO_SAMPLE_RATE` | No | RTMS input sample rate. Use `8000`, `16000`, `32000`, or `48000`; default `48000` |
| `TARGET_CHUNK_DURATION_MS` | No | Audio chunk size sent to OpenAI, default `100` |

Default Zoom MCP allowlist:

```text
search_meetings,search_zoom,get_meeting_assets,get_recording_resource,get_file_content,recordings_list,create_new_file_with_markdown
```

`create_new_file_with_markdown` writes Zoom Docs. The assistant instructions restrict it to explicit requests to create, save, or write a Zoom Doc. For stricter production behavior, put write tools behind an approval flow or a backend function that validates the content before writing.

If the assistant says it cannot create Zoom Docs, check the live `.env` value, not only `.env.example`. The write tool is exposed only when `ZOOM_MCP_ALLOWED_TOOLS` includes `create_new_file_with_markdown`:

```env
ZOOM_MCP_ALLOWED_TOOLS="search_meetings,search_zoom,get_meeting_assets,get_recording_resource,get_file_content,recordings_list,create_new_file_with_markdown"
```

On startup, the app prints the active allowlist:

```text
[OpenAI Realtime] Zoom MCP allowed tools: search_meetings, search_zoom, get_meeting_assets, get_recording_resource, get_file_content, recordings_list, create_new_file_with_markdown
```

The assistant has short routing guidance for each allowed Zoom MCP tool:

- `search_meetings`: find past, recent, upcoming, or named meetings.
- `get_meeting_assets`: retrieve summaries, notes, participants, agenda docs, recordings, and meeting-linked docs for a specific meeting.
- `recordings_list`: find cloud recordings by date, host, or meeting number.
- `get_recording_resource`: retrieve recording transcripts, summaries, next steps, or playback links.
- `search_zoom`: search Zoom Docs, meeting notes, or Team Chat.
- `get_file_content`: read a specific Zoom Doc after selecting its file ID.
- `create_new_file_with_markdown`: create or save a Zoom Doc only after an explicit user request.

## Notes

- Do not commit `.env`; keep `ZOOM_MCP_ACCESS_TOKEN` and `OPENAI_API_KEY` in environment variables.
- The Zoom MCP access token should be a user OAuth token with the MCP granular scopes required by the tools you allow.
- The sample logs MCP approval requests but does not implement an approval UI. Keep `ZOOM_MCP_REQUIRE_APPROVAL=never` only for tools you are comfortable auto-running.
- Raw MCP outputs are hidden from logs by default. Console logs show compact result summaries, while the assistant is instructed to summarize MCP results instead of dumping raw JSON or full transcripts.
- Remote MCP servers do not receive the full conversation automatically, but they can see whatever arguments the model sends in tool calls.
- Cost logs are estimates from Realtime `response.done` usage events. In one observed run, the console estimate was `$1.57` while actual billed usage was `$1.17`. Treat the estimate as directional until pricing and billing reconciliation are tuned further.
- Cost estimates cover Realtime model text/audio tokens only. Transcription model billing, Zoom/MCP-side API costs, cached-token discounts, and OpenAI pricing changes are not automatically detected.

## Key Files

| File | Purpose |
|------|---------|
| `index.js` | RTMS server, webhook handling, and audio event forwarding |
| `openaiRealtime.js` | OpenAI Realtime WebSocket client, audio resampling, Zoom MCP session config |
| `.env.example` | Environment variable template |
| `package.json` | Node dependencies |

## Docker

The project forwards RTMS audio to the OpenAI Realtime API. Its multi-stage Dockerfile keeps build tooling out of the final runtime image and does not hard-code a CPU architecture.

Build and run it from the `rtms-samples` repository root:

```bash
docker build -f audio/send_audio_to_openai_realtime_api/Dockerfile -t rtms-audio-send_audio_to_openai_realtime_api .
docker run --rm --env-file audio/send_audio_to_openai_realtime_api/.env -p 3000:3000 rtms-audio-send_audio_to_openai_realtime_api
```

Run the build from the repository root because the Dockerfile uses repository-relative paths. Runtime secrets are supplied with `--env-file` and are excluded from the image build context.
