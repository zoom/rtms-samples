# AI RAG Customer Support (Agent Assist)

Answer customer questions in real time during Zoom meetings using grounded Retrieval-Augmented Generation (RAG) over your local knowledge base (`docs/`).

> **Built with [RTMSManager](../../library/readme.md)** — Zoom's JavaScript library for real-time media streaming.

## Quick Start

```bash
npm install
cp .env.example .env   # Fill in your Zoom & OpenRouter credentials
# Add PDF, DOCX, TXT, or MD documents to docs/
npm test
npm start
```

Expose with ngrok: `ngrok http 3000`

## What This Sample Does

- **Real Retrieval with Automatic Fallback**: Splits knowledge base documents into overlapping chunks with full citation metadata (`fileName`, `chunkIndex`, `snippet`). Supports OpenAI/OpenRouter dense embeddings (`EMBEDDING_MODEL_ID`) blended with a deterministic, zero-external-dependency **BM25 + TF-IDF hybrid scorer** so retrieval works accurately out of the box even without a paid embedding endpoint.
- **Grounded Answers with Source Citations**: Uses `MODEL_ID` via OpenRouter to produce concise, bullet-point Agent Assist cards with confidence badges and expandable source citations. If the LLM is unavailable, grounded KB excerpts are returned instead of crashing.
- **Agent vs. Customer Role Awareness**: Automatically identifies the Zoom App user as the **Agent**, lets the agent toggle any speaker between Customer and Agent, and only auto-triggers RAG on substantive customer questions (skipping greetings/filler and agent small talk).
- **Transcript Rewind & Meeting Isolation**: Uses `TranscriptRevisionStore` to update corrected sentences in place, broadcasts strictly per meeting via `broadcastToMeeting`, and clears meeting state on `meeting.rtms_stopped`.
- **Manual Search & Live KB Reload**: Agents can run ad-hoc KB searches (`POST /api/search` or over WebSocket), inspect loaded documents (`GET /api/kb`), and hot-reload `docs/` (`POST /api/kb/reload`) without restarting the server.
- **Agent Assist Zoom Sidebar UI**: Responsive sidebar with Suggestion Cards (Copy, Pin, expandable Source Citations), live transcript with role toggles, host `Start RTMS` / `Stop RTMS` controls, and WebSocket auto-reconnect with exponential backoff.

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ZOOM_SECRET_TOKEN` | Yes | — | Webhook Secret Token from Zoom Marketplace |
| `ZOOM_CLIENT_ID` | Yes | — | Client ID from Zoom Marketplace |
| `ZOOM_CLIENT_SECRET` | Yes | — | Client Secret from Zoom Marketplace (also verifies `x-zoom-app-context`) |
| `PORT` | No | `3000` | HTTP server port |
| `WEBHOOK_PATH` | No | `/webhook` | Webhook endpoint path |
| `FRONTEND_WSS_URL_TO_CONNECT_TO` | No | Auto-generated | Public `wss://.../ws` URL |
| `FRONTEND_WSS_AUTH_TOKEN` | No | — | Optional shared token for pre-RTMS WebSocket registration |
| `ALLOW_PRE_RTMS_REGISTRATION` | No | `false` | Set `true` only for local development outside Zoom |
| `OPENROUTER_API_KEY` | Yes | — | OpenRouter API key |
| `MODEL_ID` | No | `meta-llama/llama-4-maverick:free` | OpenRouter chat model ID |
| `EMBEDDING_MODEL_ID` | No | — | Optional embeddings model ID for hybrid dense + lexical search |
| `RAG_MIN_SCORE` | No | `0.12` | Minimum relevance score threshold `[0..1]` |
| `RAG_MIN_QUERY_CHARS` | No | `12` | Minimum characters before auto-triggering RAG |
| `WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS` | No | `300` | Replay window for Zoom webhook signature verification |

## API Endpoints

- `GET /` — Renders the Agent Assist Zoom App UI (mints a short-lived HMAC WebSocket token when `x-zoom-app-context` is verified).
- `GET /api/kb` — Lists loaded knowledge base documents, chunk counts, and retrieval mode.
- `POST /api/kb/reload` — Re-indexes all supported files (`.pdf`, `.docx`, `.txt`, `.md`) in `docs/`.
- `POST /api/search` — Runs a manual RAG query (`{ "query": "...", "meetingId": "..." }`) and returns a grounded Suggestion Card.

## Key Files

| File | Purpose |
|------|---------|
| `index.js` | Express server, RTMSManager, WebhookManager, meeting-scoped FrontendWssManager, and API routes |
| `ragPipeline.js` | KB loading/reloading, customer intent filter, grounded RAG orchestration |
| `langchain/embedUtils.js` | Recursive document chunking with citation metadata + BM25/TF-IDF & dense embedding hybrid retriever |
| `chatWithOpenrouter.js` | OpenRouter chat client honoring `MODEL_ID` with `res.ok` validation and structured JSON output |
| `supportSessionStore.js` | Per-meeting `TranscriptRevisionStore` integration, Agent/Customer roles, suggestion history |
| `wsAuth.js` | Zoom `x-zoom-app-context` verification, HMAC WS token minting, and `authorizeRegistration` |
| `views/index.ejs` | Responsive Agent Assist Zoom App UI |
| `tests/ragPipeline.test.js` | Unit tests for retrieval, citations, intent filtering, sessions, and WS auth |

## Verification

```bash
npm run check
npm test
```

## Docker

Build and run from the `rtms-samples` repository root:

```bash
docker build -f zoom_apps/ai_rag_customer_support_js/Dockerfile -t rtms-zoom_apps-ai_rag_customer_support_js .
docker run --rm --env-file zoom_apps/ai_rag_customer_support_js/.env -p 3000:3000 rtms-zoom_apps-ai_rag_customer_support_js
```
