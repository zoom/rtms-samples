# AI Dungeons & Dragons Game

Play a voice-controlled tabletop Dungeons & Dragons adventure inside Zoom Meetings with an AI Dungeon Master powered by RTMS live transcripts.

> **Built with [RTMSManager](../../library/readme.md)** — Zoom's JavaScript library for real-time media streaming.

## Quick Start

```bash
npm install
cp .env.example .env   # Fill in your credentials
node index.js
```

Expose locally with ngrok: `ngrok http 3000`

## What This Sample Does

- Maintains **per-meeting campaign state** (`scene`, `party`, bounded `history` + rolling summary, `diceLog`, and `inCharacter` toggle) isolated by `meetingId` and cleaned up on `meeting.rtms_stopped`.
- Handles RTMS transcript rewinds (`isUpdate` / `sentenceId`) via `TranscriptRevisionStore` and batches rapid turns so casual table banter doesn't spam the Dungeon Master.
- Auto-populates the **Party Roster** (class, HP, AC, gold, inventory) as Zoom participants join or speak.
- Provides an interactive **d4–d20 / skill dice roller** (via WebSocket and `POST /api/dice`), clickable DM-suggested actions & skill checks, an **In-Character / OOC Pause** toggle, **Reset Campaign**, and explicit **Start/Stop RTMS** controls.
- Authorizes frontend WebSocket clients fail-closed with `FrontendWssManager` (`authorizeRegistration` + `broadcastToMeeting`).

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ZOOM_SECRET_TOKEN` | Yes | Webhook secret token from Zoom Marketplace |
| `ZOOM_CLIENT_ID` | Yes | Zoom App Client ID |
| `ZOOM_CLIENT_SECRET` | Yes | Zoom App Client Secret |
| `OPENROUTER_API_KEY` | Yes | OpenRouter API key for Dungeon Master completions |
| `OPENROUTER_MODEL` | No | OpenRouter model ID (default: `openai/gpt-4o-mini`) |
| `PORT` | No | Server port (default: `3000`) |
| `WEBHOOK_PATH` | No | Webhook path (default: `/webhook`) |
| `FRONTEND_WSS_URL_TO_CONNECT_TO` | No | Explicit `wss://` URL (auto-detected if empty) |
| `DND_TURN_BATCH_MS` | No | Turn-batching delay in ms (default: `1500`) |
| `FRONTEND_WSS_AUTH_TOKEN` | No | Optional shared token for WS registration |
| `ALLOW_PRE_RTMS_REGISTRATION` | No | Set `true` in local dev to allow pre-RTMS WS registration |
| `WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS` | No | Replay window for webhook verification (default: `300`) |

## Key Files

| File | Purpose |
|------|---------|
| `index.js` | Express server, `RTMSManager`, `FrontendManager`, `FrontendWssManager`, `WebhookManager`, and `/api/*` endpoints |
| `dndGame.js` | Per-meeting `DndCampaignManager`, `TranscriptRevisionStore`, turn batching, dice engine, party roster, and structured DM parser |
| `chatWithOpenrouter.js` | OpenRouter chat completions client sending true multi-turn `messages` arrays with `res.ok` checks |
| `wsAuth.js` | `x-zoom-app-context` decryption, HMAC token minting/verification, and `authorizeRegistration` |
| `views/index.ejs` | Tabletop Zoom App UI with scene banner, DM chronicle, dice roller, party roster, and safe DOM rendering |

## Running Tests

```bash
npm test
```

## Docker

Build and run from the `rtms-samples` repository root:

```bash
docker build -f zoom_apps/ai_dnd_game_js/Dockerfile -t rtms-zoom_apps-ai_dnd_game_js .
docker run --rm --env-file zoom_apps/ai_dnd_game_js/.env -p 3000:3000 rtms-zoom_apps-ai_dnd_game_js
```
