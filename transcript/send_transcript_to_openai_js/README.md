# Send Transcript to OpenAI

This sample receives Zoom meeting transcript events through RTMS and sends each transcript segment to a configurable OpenAI model. It uses [RTMSManager](../../library/README.md), the OpenAI Responses API, authenticated Zoom webhooks, and local usage controls.

## Prerequisites

- Node.js 22 or newer
- A Zoom app with RTMS enabled and the `meeting.rtms_started` and `meeting.rtms_stopped` webhook events
- An OpenAI API key with access to the configured model
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
| `OPENAI_API_KEY` | required | OpenAI API credential |
| `OPENAI_MODEL` | `gpt-4.1-mini` | Model passed to the Responses API |
| `OPENAI_TIMEOUT_MS` | `20000` | Timeout for each provider attempt |
| `OPENAI_MAX_RETRIES` | `2` | SDK retry limit for retryable failures |
| `OPENAI_MAX_OUTPUT_TOKENS` | `512` | Maximum generated tokens per response |
| `OPENAI_MAX_INPUT_CHARACTERS` | `12000` | Maximum request context size |
| `OPENAI_MAX_REQUESTS_PER_MINUTE` | `30` | Process-wide local request-rate limit; `0` disables it |
| `OPENAI_MAX_REQUESTS_PER_STREAM` | `300` | Request limit per RTMS stream; `0` disables it |
| `OPENAI_MAX_SPEND_USD_PER_STREAM` | `1` | Estimated spend limit per RTMS stream; `0` disables it |
| `OPENAI_INPUT_COST_PER_MILLION_TOKENS` | `0.4` | Input price used only for local spend estimation |
| `OPENAI_OUTPUT_COST_PER_MILLION_TOKENS` | `1.6` | Output price used only for local spend estimation |
| `PORT` | `3000` | HTTP server port |
| `WEBHOOK_PATH` | `/webhook` | Zoom webhook route |
| `WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS` | `300` | Maximum signed-webhook timestamp age |
| `MEDIA_SOCKET_CONNECTION_MODE` | `split` | RTMS media socket mode |

Provider pricing changes independently of this sample. If `OPENAI_MODEL` changes, update both cost variables using the current [OpenAI API pricing](https://openai.com/api/pricing/) so the local spend estimate remains meaningful. Provider-side quotas and billing limits remain authoritative.

## Behavior

The sample subscribes only to RTMS transcript data. A verified normal webhook receives HTTP 200 before RTMS connection work starts. Each transcript event is sent as an independent OpenAI request, so conversation history is not retained.

Timeouts and retry limits are enforced by the OpenAI SDK. Local controls reject oversized input, excessive request rates, per-stream request counts, and projected per-stream spend before a request is sent. Actual token usage replaces the reservation after a successful response. Per-stream accounting is cleared when `meeting.rtms_stopped` arrives.

Provider errors are logged as sanitized fields with an error code, suggested action, retryability, status, and request ID when available. Response bodies and API credentials are not logged.

## Webhook Security

Normal webhook deliveries are verified against the exact raw body using `x-zm-signature`, `x-zm-request-timestamp`, and `ZOOM_SECRET_TOKEN`. Missing, invalid, or stale signatures are rejected. URL-validation challenges are signed with the same secret token.

## Docker

Build from the repository root because the multi-stage Dockerfile copies the shared JavaScript library:

```bash
docker build -f transcript/send_transcript_to_openai_js/Dockerfile -t rtms-openai-transcript .
docker run --rm --env-file transcript/send_transcript_to_openai_js/.env -p 3000:3000 rtms-openai-transcript
```

Runtime secrets are supplied through `--env-file` and are not copied into the image.

## Files

- `index.js`: HTTP server, webhook verification, and RTMS event handling
- `chatWithOpenAI.js`: Responses API client and request controls
- `.env.example`: complete configuration template
- `Dockerfile`: platform-agnostic multi-stage Node.js image

See [Zoom App Setup](../../ZOOM_APP_SETUP.md) and [RTMSManager documentation](../../library/README.md) for shared setup.
