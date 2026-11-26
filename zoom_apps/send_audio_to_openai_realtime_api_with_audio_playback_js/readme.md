# Send Audio to OpenAI Realtime API with Zoom App Audio Playback

This Zoom App sample streams live Zoom RTMS mixed meeting audio to the OpenAI Realtime API (with optional MCP tools), receives OpenAI Realtime PCM16 audio output, and plays gapless audio inside the Zoom App webview alongside hybrid text prompting, live MCP tool-call cards, and token/cost telemetry.

## What This Sample Does

1. Runs an Express app with a Zoom App frontend and meeting-scoped authenticated WebSocket (`FrontendWssManager`).
2. Uses the Zoom App SDK frontend to start and stop RTMS, unlock browser audio even when joining an active stream, toggle playback mute, and toggle **Speaker-Safe (Half-Duplex)** mode.
3. Receives Zoom RTMS mixed audio as mono L16 and resamples 48 kHz -> 24 kHz using a 23-tap Blackman-windowed low-pass FIR half-band decimation filter with cross-chunk continuity.
4. Streams 24 kHz PCM16 audio to OpenAI Realtime (`gpt-realtime-2`) with server VAD (`create_response: true`, `interrupt_response: true`) and optional allowlisted HTTPS MCP servers.
5. Plays assistant PCM16 audio seamlessly using scheduled Web Audio (`source.start(nextPlayTime)`) with a ~60 ms jitter buffer.
6. Supports **hybrid voice + text prompts** via the built-in text composer wired to `conversation.item.create` + `response.create`.
7. Renders live **MCP tool-call status cards** and real-time **token/cost telemetry** in the Zoom App UI.
8. Stops queued/scheduled assistant audio immediately on barge-in and sends accurate `conversation.item.truncate` timing back to OpenAI.

Playback is local to the Zoom App webview and does not inject assistant audio as a meeting participant microphone track.

## Quick Start

```bash
npm install
cp .env.example .env
npm start
```

Run unit tests:

```bash
npm test
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ZOOM_SECRET_TOKEN` | Yes | Zoom webhook secret token |
| `ZOOM_CLIENT_ID` | Yes | Zoom app client ID |
| `ZOOM_CLIENT_SECRET` | Yes | Zoom app client secret (also verifies `x-zoom-app-context`) |
| `PORT` | No | Server port, default `5050` |
| `WEBHOOK_PATH` | No | Webhook path, default `/webhook` |
| `FRONTEND_WSS_URL_TO_CONNECT_TO` | No | Public frontend WebSocket URL. Auto-derived from request host if omitted |
| `FRONTEND_WSS_AUTH_TOKEN` | No | Optional static shared token for frontend WS registration |
| `ALLOW_PRE_RTMS_REGISTRATION` | No | Set `true` in local dev to allow WS registration before RTMS starts |
| `MODE` | No | `webhook` or `websocket`, default `webhook` |
| `OPENAI_API_KEY` | Yes | OpenAI API key |
| `OPENAI_REALTIME_MODEL` | No | Realtime model, default `gpt-realtime-2` |
| `OPENAI_REALTIME_VOICE` | No | Audio output voice, default `marin` |
| `OPENAI_AUDIO_SAMPLE_RATE` | No | OpenAI PCM sample rate, must be `24000` |
| `OPENAI_VAD_CREATE_RESPONSE` | No | Let server VAD trigger responses automatically, default `true` |
| `OPENAI_REALTIME_TRANSCRIPTION_ENABLED` | No | Enable async input transcription logs and UI transcript messages, default `true` |
| `OPENAI_REALTIME_TRANSCRIPTION_MODEL` | No | Transcription model, default `gpt-4o-mini-transcribe` |
| `OPENAI_REALTIME_COST_LOGGING_ENABLED` | No | Log and display per-response and cumulative token/cost estimates, default `true` |
| `OPENAI_SPEAKER_SAFE_TAIL_COOLDOWN_MS` | No | Cooldown after assistant speech finishes before un-gating mic in Speaker-Safe mode, default `450` |
| `MCP_SERVERS_JSON` | No | JSON array of HTTPS MCP servers and explicit tool allowlists |
| `AUDIO_SAMPLE_RATE` | No | RTMS input sample rate (`8000`, `16000`, `32000`, or `48000`), default `48000` |
| `TARGET_CHUNK_DURATION_MS` | No | Audio chunk size sent to OpenAI, default `100` |

## Key Files

| File | Purpose |
|------|---------|
| `index.js` | Express app, `RTMSManager`, `FrontendWssManager`, and webhook/websocket event handling |
| `frontendAuth.js` | `x-zoom-app-context` verification, HMAC token minting, and `authorizeRegistration` |
| `audioResampler.js` | Low-pass FIR half-band decimation filter & resampler |
| `openaiRealtime.js` | Per-meeting OpenAI Realtime client, MCP tool events, usage telemetry, and Speaker-Safe gating |
| `public/audio-client.js` | Gapless scheduled Web Audio playback, hybrid text messaging, and auto-reconnecting WS client |
| `public/index.ejs` | Zoom App UI with audio controls, telemetry bar, MCP tool cards, and hybrid prompt bar |
| `.env.example` | Environment variable template |
