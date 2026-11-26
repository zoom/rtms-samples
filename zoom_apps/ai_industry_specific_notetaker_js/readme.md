# AI Industry-Specific Notetaker

Real-time meeting notetaker for Zoom Apps powered by RTMS live transcripts and selectable industry-specific structured note templates.

> **Built with [RTMSManager](../../library/readme.md)** — Zoom's JavaScript library for real-time media streaming.

## Quick Start

```bash
npm install
cp .env.example .env   # Fill in your credentials
node index.js
```

Expose locally with ngrok: `ngrok http 3000`

## What This Sample Does

- Supports **6 selectable Industry Templates** per meeting via WebSocket or REST (`POST /api/template`):
  - `general` — Executive Summary, Key Decisions, Risks & Blockers, Next Steps
  - `healthcare_soap` — Subjective, Objective, Assessment, Plan
  - `legal_compliance` — Matter & Parties, Obligations & Clauses, Compliance Risks, Approvals & Deadlines
  - `sales_meddic` — Metrics, Economic Buyer, Decision Criteria, Decision Process, Identify Pain, Champion
  - `finance_advisory` — Client Goals, Portfolio & Risk Profile, Recommendations, Disclosures & Follow-ups
  - `engineering_rfc` — Problem Statement, Proposed Architecture, Tradeoffs & Risks, Rollout & Owners
- Runs a **single batched structured-JSON LLM extraction call** (`nlp/industryExtractor.js`) on rewind-deduplicated turns (`TranscriptRevisionStore`), with graceful local regex/heuristic fallback if the LLM key is unset or unavailable.
- Isolates all notes, transcripts, and WebSocket broadcasts **per meeting** via `FrontendWssManager` (`authorizeRegistration` + `broadcastToMeeting`), generating a final wrap-up summary on `meeting.rtms_stopped` before cleaning up memory.
- Renders a tabbed Zoom App sidebar UI (Structured Notes, Action Items with checkboxes, Live Transcript with in-place rewind updates, Entities & Topics) plus Start/Stop RTMS buttons and Markdown/JSON export.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ZOOM_SECRET_TOKEN` | Yes | Webhook validation secret token from Zoom Marketplace |
| `ZOOM_CLIENT_ID` | Yes | Zoom App Client ID |
| `ZOOM_CLIENT_SECRET` | Yes | Zoom App Client Secret |
| `OPENROUTER_API_KEY` | No | OpenRouter API key (falls back to local extraction if omitted) |
| `OPENROUTER_MODEL` | No | OpenRouter model ID (default: `openai/gpt-4o-mini`) |
| `DEFAULT_INDUSTRY_TEMPLATE` | No | Initial template ID (default: `general`) |
| `NOTETAKER_BATCH_SIZE` | No | New turns before triggering extraction (default: `3`) |
| `NOTETAKER_BATCH_DELAY_MS` | No | Debounce timer for batched extraction in ms (default: `4000`) |
| `PORT` | No | Server port (default: `3000`) |
| `WEBHOOK_PATH` | No | Webhook path (default: `/webhook`) |
| `FRONTEND_WSS_URL_TO_CONNECT_TO` | No | Explicit `wss://` URL (auto-detected if empty) |
| `FRONTEND_WSS_AUTH_TOKEN` | No | Optional shared token for WS registration |
| `ALLOW_PRE_RTMS_REGISTRATION` | No | Set `true` in local dev to allow pre-RTMS WS registration |
| `WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS` | No | Replay window for webhook verification (default: `300`) |

## Key Files

| File | Purpose |
|------|---------|
| `index.js` | Express server, `RTMSManager`, `FrontendManager` (`views/` separate from `public/`), `FrontendWssManager`, `WebhookManager`, and `/api/*` routes |
| `notetakerSessionManager.js` | Per-meeting session store, `TranscriptRevisionStore` rewind handling, batch scheduling, wrap-up cleanup, and Markdown export |
| `nlp/industryExtractor.js` | 6 industry templates, single-call structured JSON OpenRouter extractor, and local fallback |
| `nlp/actionItems.js` | Pattern-based action item extractor used by the local fallback |
| `wsAuth.js` | `x-zoom-app-context` decryption, HMAC token minting/verification, and `authorizeRegistration` |
| `views/index.ejs` | Tabbed Zoom sidebar UI with safe DOM rendering, WS auto-reconnect, and Markdown/JSON export |

## Running Tests

```bash
npm test
```

## Docker

Build and run from the `rtms-samples` repository root:

```bash
docker build -f zoom_apps/ai_industry_specific_notetaker_js/Dockerfile -t rtms-zoom_apps-ai_industry_specific_notetaker_js .
docker run --rm --env-file zoom_apps/ai_industry_specific_notetaker_js/.env -p 3000:3000 rtms-zoom_apps-ai_industry_specific_notetaker_js
```
