# Zoom Decisions Sales Conversation Copilot

A Zoom App that receives live Zoom Meeting transcripts through RTMS and calls the **Zoom AI Services Decisions API** (`zoom-decisions`) to make bounded, confidence-scored sales decisions in real time.

> Built with [RTMSManager](../../library/readme.md), the Zoom Apps SDK, and the Zoom AI Services Decisions API (`/v2/aiservices/decisions/decide`).
> Looking for the OpenRouter / TypeSafe Jev version instead? See [jev_transcript_analysis_js](../jev_transcript_analysis_js/readme.md).

## Key Capabilities

- **Bounded Zoom Decisions Layer**: Evaluates each buyer turn across six parallel typed questions (`choice`: buyer intent, objection, deal stage, next action; `predicate`: purchase signal; `score`: deal risk) and selects from reviewed, application-owned coaching phrases.
- **Transcript Rewind Support (`TranscriptRevisionStore`)**: Revisions (`isUpdate: true`, same `sentenceId`) update the existing turn in place instead of creating duplicate turns or firing redundant Decisions calls.
- **Complete Short-Turn Context**: Short utterances (`"Yes."`, `"No."`, `"$50k"`, `"Q3"`) are always recorded in rolling history even when below `SALES_MIN_TRANSCRIPT_CHARACTERS`, so subsequent Zoom Decisions calls see the full dialogue.
- **Explicit Buyer vs. Seller Role Tagging**: Every turn in the decision input is tagged `[Buyer]` or `[Seller]`. The Zoom App user registers their role (`Seller` by default) and can toggle any speaker's role live. Seller turns stay in context and appear in the timeline while skipping redundant inference.
- **Bounded / Coalesced Request Queue**: Limits queued Zoom Decisions inference to at most one pending request per stream so fast speech never builds unbounded lag.
- **Pre-RTMS Registration, Auto-Reconnect & Late-Join Replay**: Supports active RTMS registration, verified `x-zoom-app-context` HMAC tokens, optional `FRONTEND_WSS_AUTH_TOKEN`, exponential-backoff WebSocket auto-reconnect, `rtms_started`/`rtms_stopped` lifecycle updates, and full `session_snapshot` replay for late joiners.
- **Sales Cockpit UI**: Keeps the hero Buyer quote strictly paired with Buyer coaching metrics, displays Purchase Signal & Deal Risk trend deltas and sparklines, includes optional host `Start RTMS` / `Stop RTMS` buttons, and provides one-click **Markdown / JSON Sales Recap Export**.

## Environment Variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `ZOOM_CLIENT_ID` | Yes | — | Zoom Marketplace app client ID |
| `ZOOM_CLIENT_SECRET` | Yes | — | Signs RTMS handshakes and verifies `x-zoom-app-context` |
| `ZOOM_SECRET_TOKEN` | Yes | — | Verifies Zoom webhook signatures |
| `ZOOM_AI_SERVICES_API_KEY` | Yes | — | Server-side API key (`x-api-key`) for Zoom Decisions API |
| `PORT` | No | `3000` | HTTP server port |
| `WEBHOOK_PATH` | No | `/webhook` | Zoom webhook endpoint |
| `FRONTEND_WSS_URL_TO_CONNECT_TO` | No | Auto-generated | Public `wss://.../ws` URL |
| `FRONTEND_WSS_AUTH_TOKEN` | No | — | Optional shared token for pre-RTMS WS registration |
| `ALLOW_PRE_RTMS_REGISTRATION` | No | `false` | Local dev opt-in for pre-RTMS WS registration |
| `ZOOM_DECISIONS_URL` | No | `https://api.zoom.us/v2/aiservices/decisions/decide` | Zoom Decisions endpoint |
| `ZOOM_DECISIONS_MODEL` | No | `zoom-decisions` | Zoom Decisions model ID |
| `ZOOM_DECISIONS_TIMEOUT_MS` | No | `10000` | Per-request timeout |
| `SALES_HISTORY_TURNS` | No | `12` | Rolling turns included in decision input |
| `SALES_MIN_TRANSCRIPT_CHARACTERS` | No | `8` | Minimum characters to trigger inference (shorter turns are still stored in history) |
| `SALES_CONTEXT` | No | `B2B software sales conversation` | Product & sales motion context |

## Run & Verify

```bash
npm install
cp .env.example .env
npm run check
npm test
npm start
```

## Project Files

| File | Purpose |
|---|---|
| `index.js` | RTMSManager, WebhookManager, FrontendWssManager, role sync, and lifecycle broadcasts |
| `zoomDecisionsSalesAnalyzer.js` | Zoom Decisions question contract (`choice`, `predicate`, `score`), API client, `[Buyer]`/`[Seller]` tagged history, coalesced queue |
| `salesSessionStore.js` | `TranscriptRevisionStore` rewind handling, speaker roles, late-join snapshot |
| `wsAuth.js` | Zoom `x-zoom-app-context` decryption, HMAC WS token mint/verify, `authorizeRegistration` |
| `public/index.ejs` | Sales Copilot Zoom App UI with trends, role toggles, RTMS controls, and recap export |
| `tests/zoomDecisionsSalesAnalyzer.test.js` | Unit tests for Zoom Decisions contract, short-turn history, role tagging, coalescing, rewind, and WS auth |

## Docker

Build from the repository root:

```bash
docker build -f zoom_apps/zoom_decisions_sales_copilot_js/Dockerfile -t rtms-zoom-decisions-sales-copilot .
docker run --rm --env-file zoom_apps/zoom_decisions_sales_copilot_js/.env -p 3000:3000 rtms-zoom-decisions-sales-copilot
```
