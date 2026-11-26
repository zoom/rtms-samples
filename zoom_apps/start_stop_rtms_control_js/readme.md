# Start/Stop RTMS Control & Diagnostics Console

A Zoom App that demonstrates programmatic control of RTMS streaming (`startRTMS`, `pauseRTMS`, `resumeRTMS`, `stopRTMS`, `getRTMSStatus`, `onRTMSStatusChange`) from within a Zoom Meeting, paired with a live RTMS diagnostics console showing throttled per-media telemetry, live transcripts with in-place rewind corrections, meeting chat, and active speaker / participant tracking.

> **Built with [RTMSManager](../../library/readme.md)** - Zoom's JavaScript library for real-time media streaming.

## Quick Start

```bash
npm install
cp .env.example .env   # Fill in your Zoom credentials
npm test
npm run check
npm start
```

Expose with ngrok: `ngrok http 3000`

## What This Sample Does

- **Programmatic RTMS Controls**: Synchronizes Start, Pause, Resume, and Stop button states with `zoomSdk.getRTMSStatus()`, `onRTMSStatusChange`, and backend `meeting.rtms_started` / `meeting.rtms_stopped` lifecycle events, displaying host/consent SDK errors inline.
- **Throttled Live Media Telemetry**: Aggregates high-frequency RTMS audio, video, screenshare, transcript, and chat packets into 1-second telemetry snapshots (packets/sec, KB/s, fps, active state, active speaker, and participants) instead of flooding the browser WebSocket.
- **In-Place Transcript Rewinds**: Uses `TranscriptRevisionStore` so RTMS transcript corrections (`isUpdate` / `sentenceId`) update existing lines in place instead of duplicating output.
- **Secure Frontend WebSocket Registration**: Authorizes frontend clients via active RTMS meeting match, HMAC-signed token minted from verified `x-zoom-app-context` headers on `GET /`, optional `FRONTEND_WSS_AUTH_TOKEN`, or dev-only `ALLOW_PRE_RTMS_REGISTRATION=true`. Frontend reconnects automatically with exponential backoff.
- **Webhook or Event WebSocket Mode**: Uses `WebhookManager` (signature + replay-window verified) or `WebsocketManager` (with heartbeat, reconnect, and clean shutdown).

## Prerequisites

- Node.js v20+
- Zoom account with RTMS enabled
- Zoom App configured in Marketplace with RTMS SDK APIs enabled
- Public HTTPS URL (e.g., ngrok) for local development

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ZOOM_SECRET_TOKEN` | Yes | Webhook validation token from Zoom Marketplace |
| `ZOOM_CLIENT_ID` | Yes | Your Zoom App's Client ID |
| `ZOOM_CLIENT_SECRET` | Yes | Your Zoom App's Client Secret (also decrypts `x-zoom-app-context`) |
| `PORT` | No | Server port (default: `3000`) |
| `WEBHOOK_PATH` | No | Webhook endpoint path (default: `/webhook`) |
| `WS_URL` | No | Optional explicit frontend WebSocket URL; leave blank to auto-derive via `FrontendManager` |
| `MODE` | No | Event delivery mode: `webhook` or `websocket` (default: `webhook`) |
| `zoomWSURLForEvents` | No | Zoom WebSocket URL for event subscription (`websocket` mode only) |
| `FRONTEND_WSS_AUTH_TOKEN` | No | Optional static bearer token for frontend WebSocket registration |
| `ALLOW_PRE_RTMS_REGISTRATION` | No | Set `true` for local dev without active RTMS or `x-zoom-app-context` (default: `false`) |
| `WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS` | No | Webhook replay window in seconds (default: `300`) |

## Key Files

| File | Purpose |
|------|---------|
| `index.js` | Express server, `FrontendManager`, `FrontendWssManager`, `RTMSManager`, `WebhookManager` / `WebsocketManager` wiring |
| `rtmsControlHelpers.js` | `x-zoom-app-context` decryption, HMAC WS token minting/verification, `authorizeRegistration`, and 1s `MeetingTelemetryTracker` |
| `views/index.ejs` | RTMS Control & Diagnostics Console UI with auto-reconnecting WebSocket and XSS-safe DOM rendering |
| `tests/rtmsControlHelpers.test.js` | `node --test` unit tests for auth, context decryption, telemetry throttling, and transcript rewinds |
| `.env.example` | Environment variable template |

## Troubleshooting

| Issue | Solution |
|-------|----------|
| "Cannot start RTMS: Open this Zoom App inside an active meeting" | Launch the Zoom App inside a live Zoom Meeting |
| Host or consent error banner | Only authorized hosts/participants with granted consent can start RTMS |
| WebSocket registration rejected before RTMS starts | Open via Zoom client (sends `x-zoom-app-context`), or set `ALLOW_PRE_RTMS_REGISTRATION=true` for local dev |
| Webhook not received | Verify `ZOOM_SECRET_TOKEN` matches Marketplace and ngrok HTTPS URL points to `/webhook` |

## Docker

Build and run from the `rtms-samples` repository root:

```bash
docker build -f zoom_apps/start_stop_rtms_control_js/Dockerfile -t rtms-zoom_apps-start_stop_rtms_control_js .
docker run --rm --env-file zoom_apps/start_stop_rtms_control_js/.env -p 3000:3000 rtms-zoom_apps-start_stop_rtms_control_js
```
