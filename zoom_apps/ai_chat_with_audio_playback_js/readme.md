# AI Chat with Audio Playback

Real-time AI voice assistant for Zoom Meetings using RTMS live transcripts, OpenRouter LLMs, and Deepgram neural TTS playback in the Zoom App sidebar.

> **Built with [RTMSManager](../../library/readme.md)** — Zoom's JavaScript library for real-time media streaming.

## Quick Start

```bash
npm install
cp .env.example .env   # Fill in your credentials
node index.js
```

Expose locally with ngrok: `ngrok http 3000`

## What This Sample Does

- Streams meeting transcripts via `RTMSManager` and tracks sentence revisions with `TranscriptRevisionStore`.
- Isolates conversation history, settings, and WebSocket broadcasts **per meeting** using `FrontendWssManager` (`broadcastToMeeting`) with fail-closed registration (`authorizeRegistration`).
- Prevents speaker-to-mic echo loops with **Wake-Word** mode (default: `"hey ai"`), **Push-to-Talk**, or **Auto-Reply** with cooldown & acoustic echo suppression.
- Synthesizes replies with Deepgram WAV TTS and plays them cleanly in the browser via `AudioContext.decodeAudioData()` with gapless scheduling, user-gesture audio unlock/mute, and **Interrupt / Barge-in**.
- Provides explicit **Start RTMS** / **Stop RTMS** buttons using the Zoom Apps SDK.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ZOOM_SECRET_TOKEN` | Yes | Secret token from your Zoom Marketplace app |
| `ZOOM_CLIENT_ID` | Yes | Client ID from your Zoom app |
| `ZOOM_CLIENT_SECRET` | Yes | Client secret from your Zoom app |
| `OPENROUTER_API_KEY` | Yes | OpenRouter API key for chat completions |
| `OPENROUTER_MODEL` | No | Model ID (default: `openai/gpt-4o-mini`) |
| `DEEPGRAM_API_KEY` | No | Deepgram API key for TTS audio playback (text-only fallback if omitted) |
| `DEEPGRAM_TTS_MODEL` | No | Deepgram voice model (default: `aura-asteria-en`) |
| `PORT` | No | Server port (default: `3000`) |
| `WEBHOOK_PATH` | No | Webhook route (default: `/webhook`) |
| `FRONTEND_WSS_URL_TO_CONNECT_TO` | No | Explicit `wss://` URL (auto-detected from request host if empty) |
| `MODE` | No | `webhook` (default) or `websocket` |
| `DEFAULT_RESPONSE_MODE` | No | `wake_word` (default), `push_to_talk`, or `auto` |
| `DEFAULT_WAKE_WORDS` | No | Comma-separated wake phrases (default: `hey ai,okay ai,ok ai,assistant`) |
| `FRONTEND_WSS_AUTH_TOKEN` | No | Optional shared secret token for WS client registration |
| `ALLOW_PRE_RTMS_REGISTRATION` | No | Set `true` in local dev to allow WS registration before RTMS starts |
| `WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS` | No | Webhook replay protection window in seconds (default: `300`) |

## Key Files

| File | Purpose |
|------|---------|
| `index.js` | Express server, `RTMSManager`, `FrontendManager`, `FrontendWssManager`, and `WebhookManager` wiring |
| `config.js` | CWD-safe `.env` loader and runtime configuration |
| `wsAuth.js` | `x-zoom-app-context` AES-256-GCM decryption, HMAC token minting/verification, and `authorizeRegistration` |
| `chatSessionManager.js` | Per-meeting transcript revision store, bounded sliding-window history, wake-word/PTT gating, and echo suppression |
| `chatWithOpenrouter.js` | Multi-turn OpenRouter chat completions client with `AbortSignal` support |
| `deepgramService.js` | Lazy-initialized Deepgram WAV TTS service |
| `public/index.ejs` | Zoom App sidebar UI with RTMS controls, audio unlock/mute, trigger modes, and safe DOM rendering |
| `public/audio-client.js` | Resilient reconnecting WS client + Web Audio `decodeAudioData()` gapless playback |

## Running Tests

```bash
npm test
```

## Docker

Build and run from the `rtms-samples` repository root:

```bash
docker build -f zoom_apps/ai_chat_with_audio_playback_js/Dockerfile -t rtms-zoom_apps-ai_chat_with_audio_playback_js .
docker run --rm --env-file zoom_apps/ai_chat_with_audio_playback_js/.env -p 3000:3000 rtms-zoom_apps-ai_chat_with_audio_playback_js
```
