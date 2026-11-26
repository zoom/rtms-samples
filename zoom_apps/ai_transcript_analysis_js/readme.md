# AI Transcript Analysis (Live Trait Tracker)

Real-time communication trait analysis from Zoom meeting transcripts with per-speaker breakdowns, evidence quotes, and a responsive D3.js bar chart.

> **Built with [RTMSManager](../../library/readme.md)** — Zoom's JavaScript library for real-time media streaming.

## Quick Start

```bash
npm install
cp .env.example .env   # Fill in your Zoom & OpenRouter credentials
npm test
npm start
```

Expose with ngrok: `ngrok http 3000`

## What This Sample Does

- **Meeting- & Speaker-Isolated Trait Tracking**: Tracks five communication traits (**Curiosity**, **Empathy**, **Assertiveness**, **Creativity**, **Analytical**) independently per `meetingId` and per speaker (`userId`), with automatic cleanup on `meeting.rtms_stopped`.
- **Rewind-Safe Accounting (`TranscriptRevisionStore`)**: When Zoom RTMS sends a transcript correction (`isUpdate: true`, same `sentenceId`), the tracker subtracts the sentence's prior counts and replaces its prior evidence quotes before applying the updated extraction — preventing double-counting.
- **Serialized, Coalesced Async Analysis**: Per-meeting queues serialize updates and coalesce rapid revisions of the same sentence so out-of-order LLM responses never race.
- **Evidence Quote Feed**: Displays the exact matched phrases from each utterance that caused a trait to increment.
- **Responsive Zoom-Sidebar UI**: Responsive D3.js bar chart (`viewBox` + `ResizeObserver`), **All Speakers / Per-Speaker** selector, live annotated transcript, host `Start RTMS` / `Stop RTMS` controls, and WebSocket auto-reconnect with exponential backoff.
- **Secure Static/View Separation**: EJS views live in `views/` (separate from `public/`) so template source is never served statically.

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ZOOM_SECRET_TOKEN` | Yes | — | Webhook Secret Token from Zoom Marketplace |
| `ZOOM_CLIENT_ID` | Yes | — | Client ID from Zoom Marketplace |
| `ZOOM_CLIENT_SECRET` | Yes | — | Client Secret from Zoom Marketplace |
| `PORT` | No | `3000` | HTTP server port |
| `WEBHOOK_PATH` | No | `/webhook` | Webhook endpoint path |
| `OPENROUTER_API_KEY` | Yes | — | OpenRouter API key |
| `OPENROUTER_MODEL` | No | `meta-llama/llama-4-scout:free` | OpenRouter model ID (also reads `DEFAULT_OPENROUTER_MODEL`) |
| `FRONTEND_WSS_URL_TO_CONNECT_TO` | No | Auto-generated | Public `wss://.../ws` URL |
| `FRONTEND_WSS_AUTH_TOKEN` | No | — | Optional shared token for pre-RTMS WebSocket registration |
| `ALLOW_PRE_RTMS_REGISTRATION` | No | `false` | Set `true` only for local dev outside Zoom |
| `WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS` | No | `300` | Replay window for webhook verification |

## Key Files

| File | Purpose |
|------|---------|
| `index.js` | Express server, RTMSManager, WebhookManager, meeting-scoped FrontendWssManager |
| `chatWithOpenrouterForTraits.js` | OpenRouter trait extractor + `MeetingTraitTracker` (per-meeting/speaker isolation, rewind safety, coalesced queue) |
| `wsAuth.js` | Zoom `x-zoom-app-context` verification, HMAC WS token minting, `authorizeRegistration` |
| `views/index.ejs` | Responsive D3.js + evidence quote + annotated transcript Zoom App UI |
| `public/lib/d3.v7.min.js` | Local D3 v7 bundle |
| `tests/traitsAnalyzer.test.js` | Unit tests for extraction, rewind accounting, multi-meeting isolation, and WS auth |

## Verification

```bash
npm run check
npm test
```

## Docker

Build and run from the `rtms-samples` repository root:

```bash
docker build -f zoom_apps/ai_transcript_analysis_js/Dockerfile -t rtms-zoom_apps-ai_transcript_analysis_js .
docker run --rm --env-file zoom_apps/ai_transcript_analysis_js/.env -p 3000:3000 rtms-zoom_apps-ai_transcript_analysis_js
```
