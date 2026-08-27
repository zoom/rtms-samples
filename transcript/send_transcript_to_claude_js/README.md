# Send Transcript to Claude

This sample receives Zoom meeting transcript events through RTMS and sends them to a configurable Anthropic Claude model. It uses [RTMSManager](../../library/README.md), the official Anthropic SDK, authenticated Zoom webhooks, bounded per-stream history, and local usage controls.

## Prerequisites

- Node.js 22 or newer
- A Zoom app with RTMS enabled and the `meeting.rtms_started` and `meeting.rtms_stopped` webhook events
- An Anthropic API key with access to the configured model
- A public HTTPS webhook URL for local development

## Setup

```bash
npm install
cp .env.example .env
node index.js
```

Set the Zoom webhook endpoint to your public URL plus `WEBHOOK_PATH`, for example `https://example.ngrok.app/webhook`.

## Configuration

| Variable | Default | Purpose |
|---|---:|---|
| `ZOOM_SECRET_TOKEN` | required | Verifies URL validation and signed webhook deliveries |
| `ZOOM_CLIENT_ID` | required | Zoom app client ID used by RTMS |
| `ZOOM_CLIENT_SECRET` | required | Zoom app client secret used by RTMS |
| `ANTHROPIC_API_KEY` | required | Anthropic API credential |
| `CLAUDE_MODEL` | `claude-sonnet-5` | Model passed to the Messages API |
| `CLAUDE_TIMEOUT_MS` | `20000` | Timeout for each provider attempt |
| `CLAUDE_MAX_RETRIES` | `2` | SDK retry limit for retryable failures |
| `CLAUDE_MAX_OUTPUT_TOKENS` | `512` | Maximum generated tokens per response |
| `CLAUDE_MAX_INPUT_CHARACTERS` | `40000` | Maximum request context size |
| `CLAUDE_MAX_HISTORY_MESSAGES` | `20` | Maximum retained user and assistant messages per stream |
| `CLAUDE_MAX_HISTORY_CHARACTERS` | `40000` | Maximum retained history characters per stream |
| `CLAUDE_MAX_REQUESTS_PER_MINUTE` | `30` | Process-wide local request-rate limit; `0` disables it |
| `CLAUDE_MAX_REQUESTS_PER_STREAM` | `300` | Request limit per RTMS stream; `0` disables it |
| `CLAUDE_MAX_SPEND_USD_PER_STREAM` | `1` | Estimated spend limit per RTMS stream; `0` disables it |
| `CLAUDE_INPUT_COST_PER_MILLION_TOKENS` | `2` | Input price used only for local spend estimation |
| `CLAUDE_OUTPUT_COST_PER_MILLION_TOKENS` | `10` | Output price used only for local spend estimation |
| `PORT` | `3000` | HTTP server port |
| `WEBHOOK_PATH` | `/webhook` | Zoom webhook route |
| `WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS` | `300` | Maximum signed-webhook timestamp age |
| `MEDIA_SOCKET_CONNECTION_MODE` | `split` | RTMS media socket mode |

Provider pricing changes independently of this sample. If `CLAUDE_MODEL` changes, update both cost variables using the current [Anthropic pricing](https://docs.anthropic.com/en/docs/about-claude/pricing) so the local spend estimate remains meaningful. Provider-side quotas and billing limits remain authoritative.

## Session Isolation

Conversation history is stored in a map keyed by `rtms_stream_id`; transcript data from separate meetings cannot share context. Calls for one stream are serialized to preserve message order, while different streams can run concurrently. History is trimmed by both message count and character count and is deleted when `meeting.rtms_stopped` arrives.

Timeouts and retry limits are enforced by the Anthropic SDK. Local controls reject oversized context, excessive request rates, per-stream request counts, and projected per-stream spend before a request is sent. Actual token usage replaces the reservation after a successful response.

Provider errors are logged as sanitized fields with an error code, suggested action, retryability, status, and request ID when available. Response bodies, conversation content, and API credentials are not included in provider error logs.

## Webhook Security

Normal webhook deliveries are verified against the exact raw body using `x-zm-signature`, `x-zm-request-timestamp`, and `ZOOM_SECRET_TOKEN`. Missing, invalid, or stale signatures are rejected. URL-validation challenges are signed with the same secret token. A verified normal webhook receives HTTP 200 before RTMS connection work starts.

## Docker

Build from the repository root because the multi-stage Dockerfile copies the shared JavaScript library:

```bash
docker build -f transcript/send_transcript_to_claude_js/Dockerfile -t rtms-claude-transcript .
docker run --rm --env-file transcript/send_transcript_to_claude_js/.env -p 3000:3000 rtms-claude-transcript
```

Runtime secrets are supplied through `--env-file` and are not copied into the image.

## Files

- `index.js`: HTTP server, webhook verification, and RTMS event handling
- `chatWithClaude.js`: Messages API client, isolated history, and request controls
- `.env.example`: complete configuration template
- `Dockerfile`: platform-agnostic multi-stage Node.js image

See [Zoom App Setup](../../ZOOM_APP_SETUP.md) and [RTMSManager documentation](../../library/README.md) for shared setup.
