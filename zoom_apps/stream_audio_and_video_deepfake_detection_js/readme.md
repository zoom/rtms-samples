# Stream Audio and Video Deepfake Detection

This sample demonstrates a Zoom App that controls Zoom RTMS from inside a Zoom Meeting, subscribes to a selected participant's individual RTMS video stream, filters RTMS multi-stream audio to that same selected participant, previews the isolated per-meeting media in the Zoom App panel, and runs separate video and audio deepfake verification with a combined trust verdict and rolling confidence history.

The sample is intentionally meeting-only.

Import [`manifest.json`](manifest.json) to create the user-managed in-meeting Zoom App. Replace the development and production domain placeholders first.

## Architecture

```text
Zoom App frontend
  |  Zoom Apps SDK: startRTMS / stopRTMS / meeting participant list
  |  Socket.IO (per-meeting rooms with auth): one-click participant select, verdicts, history
  v
Node.js Express backend
  |  WebhookManager: meeting.rtms_started / meeting.rtms_stopped
  |  SessionManager: per-meeting state, generation guards, isolated temp paths
  |  RTMSManager: signaling/media sockets + individual video subscription + multi-stream audio
  |  HlsPipeline (ffmpeg): silence-padded HLS preview + bounded MP4 clip ring buffer
  |  AudioClipBuffer: selected-participant PCM audio windows
  v
Video deepfake inference (POST /video/classify with AbortController timeout)
Audio verification inference (POST /audio/classify with AbortController timeout)
```

## Key Security & Reliability Features

- **Per-Meeting Isolation**: Every meeting gets its own session state, Socket.IO room (`io.to(meetingId)`), isolated HLS path (`/hls/<meetingKey>/stream.m3u8`), and private clip storage (`tmp_clips/<meetingKey>/`) outside `public/` — raw MP4 and PCM clips are never publicly served.
- **Socket Registration Auth**: Socket.IO clients register into their meeting room and are authorized via an active RTMS connection match, an HMAC-signed token minted from a verified `x-zoom-app-context` header on `GET /`, an optional `FRONTEND_WSS_AUTH_TOKEN`, or dev-only `ALLOW_PRE_RTMS_REGISTRATION=true`.
- **Cross-Participant Race Protection**: Switching participants or stopping RTMS increments a `selectionGeneration` counter, stops/wipes `HlsPipeline` and `AudioClipBuffer`, and discards any in-flight video or audio inference result from an older generation or different user.
- **HLS Mute-Stall Prevention & Clean Recovery**: `HlsPipeline` pads `pipe:4` with 100ms PCM silence chunks whenever the selected speaker is muted/silent so ffmpeg never stalls HLS output, uses fast `-probesize 1M -analyzeduration 1M`, prunes old MP4 clips to `DEEPFAKE_MAX_CLIPS`, and cleanly resets client `hls.js` playback on `hls_reset` or RTMS stop.
- **Bounded Inference Timeouts**: All video and audio `fetch()` calls use `AbortController` with `DEEPFAKE_FETCH_TIMEOUT_MS` (default `15000ms`) so a hung inference service cannot lock inference loops.
- **Combined Audio + Video Trust Verdict**: Displays a combined trust verdict and per-participant rolling confidence history bars alongside one-click participant selection in the Meeting Participants panel.

## Quick Start

```bash
cd zoom_apps/stream_audio_and_video_deepfake_detection_js
cp .env.example .env
npm install
npm test
npm run check
npm start
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `5050` | Express server port |
| `PUBLIC_BASE_URL` | `""` | Public HTTPS URL for logs and setup |
| `WEBHOOK_PATH` | `/webhook` | Zoom webhook path |
| `ZOOM_CLIENT_ID` | Required | Zoom Marketplace app Client ID |
| `ZOOM_CLIENT_SECRET` | Required | Zoom Marketplace app Client Secret (also decrypts `x-zoom-app-context`) |
| `ZOOM_SECRET_TOKEN` | Required | Webhook signature verification token |
| `FRONTEND_WSS_AUTH_TOKEN` | `""` | Optional static token for Socket.IO room registration |
| `ALLOW_PRE_RTMS_REGISTRATION` | `false` | Set `true` for local dev without active RTMS or `x-zoom-app-context` |
| `RTMS_MEDIA_TYPES` | `audio,video` | Comma-separated RTMS media types |
| `VIDEO_STREAM_MODE` | `individual` | Required individual video subscription mode |
| `AUDIO_STREAM_MODE` | `multi` | Required multi-stream individual audio mode |
| `DEEPFAKE_MODE` | `service` | `service`, `local_cli`, or `off` |
| `DEEPFAKE_SERVICE_URL` | `http://127.0.0.1:8012/video/classify` | Video inference endpoint |
| `DEEPFAKE_API_KEY` | Required in `service` mode | Bearer key for video service (and fallback for audio) |
| `DEEPFAKE_FRAME_FPS` | `5` | Inference clip downsample FPS |
| `DEEPFAKE_CLIP_SECONDS` | `2` | Video inference clip duration in seconds |
| `DEEPFAKE_MAX_CLIPS` | `12` | Max MP4 clips retained per meeting in `tmp_clips/` |
| `DEEPFAKE_FETCH_TIMEOUT_MS` | `15000` | `AbortController` timeout for inference and health requests |
| `DEEPFAKE_LOCAL_SCRIPT_PATH` | `./classify_clip.py` | Script path used when `DEEPFAKE_MODE=local_cli` |
| `AUDIO_DEEPFAKE_MODE` | `off` | `service` or `off` |
| `AUDIO_DEEPFAKE_SERVICE_URL` | — | Audio PCM classification endpoint |
| `AUDIO_DEEPFAKE_API_KEY` | Falls back to `DEEPFAKE_API_KEY` | Optional dedicated bearer key for audio service |
| `AUDIO_DEEPFAKE_HEALTHCHECK_ENABLED` | `false` | Enable `/audio/health` check before audio verification |
| `AUDIO_DEEPFAKE_CLIP_SECONDS` | `4` | Audio PCM window duration in seconds |
| `AUDIO_DEEPFAKE_MIN_RMS_DBFS` | `-65` | Skip near-silent audio windows below this dBFS threshold |
| `WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS` | `300` | Replay window for webhook signature verification |

## Files

| File | Purpose |
|------|---------|
| `index.js` | Express, Socket.IO room orchestration, webhook & RTMSManager wiring |
| `sessionManager.js` | Per-meeting `SessionManager`, `MeetingSession`, auth helpers, combined verdict & rolling history |
| `hlsPipeline.js` | Silence-padded ffmpeg HLS + bounded MP4 clip ring buffer |
| `audioClipBuffer.js` | Selected-user PCM audio to rolling `.pcm` windows |
| `deepfakeClient.js` | Timeout-protected video & audio inference clients |
| `views/index.ejs` | Zoom App panel HTML with combined trust verdict and confidence trends |
| `public/app.js` | Zoom Apps SDK, Socket.IO registration, one-click participant selection, HLS lifecycle |
| `public/styles.css` | UI styles |
| `tests/deepfakeDemo.test.js` | Unit tests for session isolation, generation guards, clip pruning, and fetch timeouts |

## Docker

Build and run from the `rtms-samples` repository root:

```bash
docker build -f zoom_apps/stream_audio_and_video_deepfake_detection_js/Dockerfile -t rtms-zoom_apps-stream_audio_and_video_deepfake_detection_js .
docker run --rm --env-file zoom_apps/stream_audio_and_video_deepfake_detection_js/.env -p 5050:5050 rtms-zoom_apps-stream_audio_and_video_deepfake_detection_js
```
