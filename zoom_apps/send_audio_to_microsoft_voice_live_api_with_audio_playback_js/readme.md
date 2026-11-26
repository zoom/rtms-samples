# Microsoft Voice Live Audio Playback for Zoom Apps

This sample captures mixed RTMS meeting audio, resamples it with a low-pass FIR half-band decimation filter from 48 kHz to 24 kHz PCM16, streams it to Microsoft's Voice Live WebSocket API for realtime transcription and voice responses, and plays gapless Web Audio with word-synced live captions inside the Zoom App webview.

```text
Zoom RTMS mixed PCM16 (48 kHz)
        -> low-pass FIR half-band decimation to PCM16 (24 kHz)
        -> Microsoft Voice Live / MAI Transcribe
        -> streamed MAI Voice audio + word timestamps
        -> meeting-scoped FrontendWssManager -> gapless Web Audio + live captions
```

Playback is local to the browser/Zoom App webview (it does not inject assistant audio into the Zoom meeting microphone).

## Key Features

- **Meeting-Scoped Authenticated WebSocket (`FrontendWssManager`)**: Frontend clients register per meeting and are authorized via active RTMS connection, `x-zoom-app-context` HMAC token, optional `FRONTEND_WSS_AUTH_TOKEN`, or `ALLOW_PRE_RTMS_REGISTRATION=true` in development.
- **Anti-Aliased FIR Decimation**: 23-tap Blackman-windowed low-pass FIR half-band decimation filter for 48 kHz -> 24 kHz downsampling with continuous cross-chunk filter state.
- **Gapless Scheduled Web Audio**: Schedules PCM16 chunks continuously (`source.start(nextPlayTime)`) with a ~60 ms jitter buffer, mute control, and explicit **Enable Audio** unlock (works even when joining an already-active RTMS stream).
- **Speaker-Safe (Half-Duplex) Mode**: Optional toggle in the toolbar that suppresses RTMS mic forwarding while the assistant is speaking (+ tail cooldown) so open speakers cannot self-interrupt.
- **Word-Synced Live Captions**: Renders `response.audio_timestamp.delta` events synchronized to Web Audio playback time.
- **Reconciled Interruption & Truncation**: Respects `auto_truncate: true` on server-VAD barge-in without sending duplicate `conversation.item.truncate` events.

## Requirements

- Node.js 20 or newer
- A Zoom App configured for RTMS audio access
- A publicly reachable HTTPS URL for the app and webhook
- A Microsoft Foundry/Speech resource with Voice Live access (`MICROSOFT_VOICE_LIVE_API_KEY` and `MICROSOFT_VOICE_LIVE_ENDPOINT`)

## Configuration

```bash
cp .env.example .env
```

| Variable | Purpose |
| --- | --- |
| `ZOOM_SECRET_TOKEN` | Authenticates Zoom webhook deliveries |
| `ZOOM_CLIENT_ID` / `ZOOM_CLIENT_SECRET` | Zoom RTMS credentials & `x-zoom-app-context` verification |
| `MICROSOFT_VOICE_LIVE_ENDPOINT` | For example `wss://RESOURCE.services.ai.azure.com/voice-live/realtime` |
| `MICROSOFT_VOICE_LIVE_API_VERSION` | Voice Live API version, default `2026-04-10` |
| `MICROSOFT_VOICE_LIVE_API_KEY` | Microsoft resource key |
| `MICROSOFT_VOICE_LIVE_MODEL` | Voice Live response model, default `gpt-realtime` |
| `MICROSOFT_TRANSCRIPTION_MODEL` | MAI transcription model, default `mai-transcribe-2` |
| `MICROSOFT_VOICE_NAME` | MAI voice, default `en-US-Harper:MAI-Voice-2.1-Flash` |
| `MICROSOFT_VOICE_TYPE` | Voice type, default `azure-standard` |
| `MICROSOFT_VAD_TYPE` | VAD implementation, default `azure_semantic_vad` |
| `MICROSOFT_AUTO_TRUNCATE` | Use server-side `auto_truncate` on VAD barge-in, default `true` |
| `MICROSOFT_ENABLE_AUDIO_TIMESTAMPS` | Request word-level timestamps for live captions, default `true` |
| `FRONTEND_WSS_AUTH_TOKEN` | Optional static shared token for frontend WS registration |
| `ALLOW_PRE_RTMS_REGISTRATION` | Set `true` in local dev to allow WS registration before RTMS starts |

## Run Locally

```bash
npm install
npm start
```

Run unit tests:

```bash
npm test
```

## Files

| File | Purpose |
| --- | --- |
| `index.js` | Express server, authenticated webhook, `RTMSManager`, and `FrontendWssManager` setup |
| `frontendAuth.js` | `x-zoom-app-context` verification, HMAC token minting, and `authorizeRegistration` |
| `audioResampler.js` | Low-pass FIR half-band decimation filter & resampler |
| `microsoftVoiceLive.js` | Per-meeting Voice Live WebSocket sessions, VAD, word timestamps, and Speaker-Safe gating |
| `public/audio-client.js` | Gapless scheduled Web Audio playback, caption sync, and auto-reconnecting WS client |
| `public/index.ejs` | Zoom App controls, audio toolbar, word-synced live captions, and conversation display |
| `.env.example` | Safe configuration template |
