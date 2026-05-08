# Stream Audio and Video Deepfake Detection

This sample demonstrates a Zoom App that controls Zoom RTMS from inside a Zoom Meeting, subscribes to a selected participant's individual RTMS video stream, filters RTMS multi-stream audio to that same selected participant, previews the selected media in the Zoom App panel, and builds separate video/audio clips for verification services.

The sample is intentionally meeting-only.

## Architecture

```text
Zoom App frontend
  |  Zoom Apps SDK: startRTMS / stopRTMS / meeting participant list
  |  Socket.IO: participant selection, in-app status labels, verification results
  v
Node.js Express backend
  |  WebhookManager: meeting.rtms_started / meeting.rtms_stopped
  |  RTMSManager: signaling/media sockets + individual video subscription + multi-stream audio
  |  ffmpeg: HLS preview + rolling MP4 inference clips
  |  PCM window buffer: selected-participant audio inference clips
  v
Video deepfake inference
  |  raw video classify URL: https://your-deepfake-service.example.com/video/classify
  |  multipart upload URL: https://your-deepfake-service.example.com/video/upload
  |  same config also accepts: http://127.0.0.1:8012
  |  example service folder: /var/www/your-deepfake-service

Audio verification inference
  |  raw PCM classify URL: https://your-deepfake-service.example.com/audio/classify
  |  configured separately from the video service
```

The Zoom App frontend does not connect directly to RTMS media sockets. The backend owns RTMSManager and uses Socket.IO to coordinate state with the frontend.

When `DEEPFAKE_MODE=service`, the Node backend performs a health probe against the configured video inference service:
- once during startup
- again when you click `Start Video Verification`

When `AUDIO_DEEPFAKE_MODE=service`, the backend performs the audio service health probe when you click `Start Audio Verification`.

## Prerequisites

- Zoom Marketplace app with the Zoom App feature enabled.
- RTMS enabled for meetings on the same app/account.
- Public HTTPS URL for the Express server.
- Node.js 20+ recommended.
- Python 3.10+ only if you are working on the standalone inference service itself.
- `ffmpeg` installed on the backend host.
- Hugging Face account access to `Naman712/Deep-fake-detection` for the standalone service.
- A Hugging Face token in the standalone service `.env` with scope: `Read access to contents of all public gated repos you can access`.

## What It Does

- Starts/stops RTMS from the Zoom App using the Zoom Apps JS SDK, with the frontend waiting for `sdk.js` to load and `zoomSdk.config(...)` to complete before enabling the RTMS buttons.
- Receives `meeting.rtms_started` / `meeting.rtms_stopped` webhooks on the backend.
- Uses RTMSManager to connect to the RTMS stream.
- Requests `audio + video` media with video configured as `VIDEO_SINGLE_INDIVIDUAL_STREAM` and audio configured as `AUDIO_MULTI_STREAMS`.
- Shows RTMS `PARTICIPANT_VIDEO_ON` users in a dropdown.
- Lets you select a user ID and click `Load Individual Video` to call `RTMSManager.subscribeToIndividualVideo(streamId, userId)`.
- Pipes selected video and the selected participant's RTMS audio packets into ffmpeg for HLS playback in the Zoom App.
- Starts video classification only after you click `Start Video Verification`.
- Builds rolling MP4 inference clips from the selected RTMS video stream.
- Downsamples those clips to `DEEPFAKE_FRAME_FPS` and cuts them at `DEEPFAKE_CLIP_SECONDS`.
- Runs deepfake detection using either a local Python classifier, a localhost Python web service, or a remote video-classification API. The current default model is `Naman712/Deep-fake-detection`.
- Starts audio verification only after you click `Start Audio Verification`.
- Builds rolling 4-second raw PCM L16 windows from the selected RTMS user's individual audio packets and posts them to the separate audio verification service.
- Shows the frontend `Current Mode` panel as video inference FPS, RTMS video FPS, video clip duration, individual audio window duration, and separate video/audio model names.
- Shows the Zoom meeting participant list inside the Zoom App panel and labels each participant separately for `Video:` and `Audio:`.

## Important Limitations

- RTMS individual video uses an explicit subscription request. RTMS individual audio is handled differently: this sample requests `AUDIO_MULTI_STREAMS` and filters incoming audio packets by the selected RTMS `userId`.
- Audio verification only advances when the selected participant is sending audio. If the selected user is silent, the PCM buffer will wait.
- The current Hugging Face model is a gated video-classification model. You need Hugging Face access to the model and an `HF_TOKEN` in the standalone inference service environment for that service to load the model. The token should have scope: `Read access to contents of all public gated repos you can access`.
- The backend no longer sends sampled JPEGs for inference. It builds short MP4 clips from the selected RTMS video stream and classifies those clips.
- The in-app participant labels still need a best-effort mapping between RTMS `user_id` and Zoom Apps participants. The UI keeps an optional Zoom participant mapping dropdown and also attempts direct user ID or display-name matching.
- Browser playback uses HLS generated by ffmpeg. `ffmpeg` must be installed on the server.

Video model used by default:
`Naman712/Deep-fake-detection`

Video model page:
https://huggingface.co/Naman712/Deep-fake-detection

This model is a gated `video-classification` model built around a ResNext50 + LSTM architecture and the model card says its best performance is around 20-frame clips. The sample uses `DEEPFAKE_FRAME_FPS=5` and `DEEPFAKE_CLIP_SECONDS=2` by default, so each inference clip provides 10 source frames; the Python processor pads to the model's 20-frame input shape. The sample normalizes the model's `real` / `fake` labels into the app's existing score fields.

Audio model used by default:
`MelodyMachine/Deepfake-audio-detection-V2`

Audio model page:
https://huggingface.co/MelodyMachine/Deepfake-audio-detection-V2

The Node sample does not load the audio model directly. It sends selected-participant audio windows to the separate `AUDIO_DEEPFAKE_SERVICE_URL` endpoint and displays the returned `real` / `fake` scores independently from the video result. The default audio window is `AUDIO_DEEPFAKE_CLIP_SECONDS=4`, using raw RTMS participant audio as PCM signed 16-bit little-endian, 16 kHz, mono. Near-silent windows are skipped by `AUDIO_DEEPFAKE_MIN_RMS_DBFS` because silence or background noise can produce misleadingly confident audio scores.

Before starting the standalone inference service, accept access on the Hugging Face model page and set a read token with scope `Read access to contents of all public gated repos you can access`:

```bash
export HF_TOKEN=your_huggingface_api_key_with_gated_repo_read_scope
curl -i \
  -H "Authorization: Bearer $HF_TOKEN" \
  https://huggingface.co/Naman712/Deep-fake-detection/resolve/main/config.json
```

Expected: `HTTP/2 200`.

## Marketplace App Setup

Create or configure a Zoom Marketplace app that supports both the Zoom App frontend and RTMS.

### 1. App Type

Use a Zoom App that runs inside meetings.

In Marketplace:
- Enable the Zoom App feature.
- Configure the Home URL or In-Meeting URL to your deployed sample URL, for example:
  - `https://your-domain.example.com/`
- Add your domain to the Zoom App allow list.

This sample serves `hls.js` from the sample backend, but it loads the official Zoom Apps SDK from `https://appssdk.zoom.us/sdk.js`, matching the other working Zoom App samples in this repo.

The frontend intentionally does not enable the RTMS buttons until:
- the Zoom Apps SDK script has loaded successfully
- `window.zoomSdk` is available
- `zoomSdk.config(...)` succeeds
- `getSupportedJsApis()` confirms `startRTMS` / `stopRTMS` are available

This avoids a client-side race where the buttons are clickable before the SDK bridge exists.

One implementation detail matters here: do not resolve a JavaScript `Promise` with `window.zoomSdk` itself while waiting for the SDK to become available. Treat the SDK as an opaque global object and only read `window.zoomSdk` after the wait completes. Resolving a Promise with the SDK object can trigger a premature `.then` lookup and surface `must call zoomSdk.config before using other API methods`.

That means your allow list should include:
- your app domain
- `https://appssdk.zoom.us/`

For local development, expose this Express server with HTTPS, for example with ngrok or a similar tunnel, then add that HTTPS domain to the allow list.

### 2. Zoom App Capabilities

The frontend requests these Zoom Apps SDK capabilities:

```text
getMeetingContext
getMeetingUUID
getMeetingParticipants
getRunningContext
getUserContext
startRTMS
stopRTMS
showNotification
```

The required RTMS control calls are:

```js
await zoomSdk.startRTMS();
await zoomSdk.stopRTMS();
```

The sample keeps `callZoomApi(...)` only as a fallback path. The primary code path matches `zoom_apps/start_stop_rtms_control_js` and uses direct JS SDK methods first.

If your Marketplace app does not enable the RTMS capabilities, the frontend will still load but the start/stop RTMS calls will fail in the Zoom client.

### 3. Zoom App Scopes

Add the Zoom Apps in-meeting scope needed for these SDK capabilities:

```text
zoomapp:inmeeting
```

If your account/app configuration exposes more granular Zoom Apps scopes, enable the scopes that correspond to:

- running inside meetings
- reading meeting context
- reading meeting participants
- starting/stopping RTMS

Users may need to re-authorize the app after scopes or capabilities change.

### 4. RTMS Feature and Webhooks

Enable RTMS for the app/account and subscribe to:

```text
meeting.rtms_started
meeting.rtms_stopped
```

Set the webhook endpoint URL to:

```text
https://your-domain.example.com/webhook
```

If you change `WEBHOOK_PATH`, update the Marketplace webhook URL accordingly.

### 5. Credentials

The Zoom App starts/stops RTMS using SDK capabilities. The backend still needs app credentials so RTMSManager can sign RTMS signaling/media handshakes after the webhook arrives.

Set these in `.env`:

```env
ZOOM_CLIENT_ID=
ZOOM_CLIENT_SECRET=
ZOOM_SECRET_TOKEN=
```

## Setup

```bash
cd zoom_apps/stream_audio_and_video_deepfake_detection_js
cp .env.example .env
npm install
```

Edit `.env` before starting the services. At minimum set:

```env
PUBLIC_BASE_URL=https://your-domain.example.com
ZOOM_CLIENT_ID=
ZOOM_CLIENT_SECRET=
ZOOM_SECRET_TOKEN=
DEEPFAKE_SERVICE_URL=https://your-deepfake-service.example.com/video/classify
DEEPFAKE_UPLOAD_URL=https://your-deepfake-service.example.com/video/upload
DEEPFAKE_API_KEY=your_huggingface_api_key_with_gated_repo_read_scope
AUDIO_STREAM_MODE=multi
AUDIO_DEEPFAKE_MODE=service
AUDIO_DEEPFAKE_SERVICE_URL=https://your-deepfake-service.example.com/audio/classify
AUDIO_DEEPFAKE_API_KEY=
AUDIO_DEEPFAKE_HEALTHCHECK_ENABLED=false
```

In `service` mode, point the sample at a standalone inference service. Example service folder:

```text
/var/www/your-deepfake-service
```

If you need to work on the service itself, keep its README beside that service folder.

### Set Up The Separate Python Inference Web Service

Use this when you want the Hugging Face deepfake model to run as its own HTTP service instead of inside the Node sample process.

1. Prepare the service folder:

```bash
cd /var/www/your-deepfake-service
cp .env.example .env
```

2. Create the virtualenv only if it does not already exist. If your service host already has a runtime, skip the first command and just activate it:

```bash
cd /var/www/your-deepfake-service
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

3. Edit `/var/www/your-deepfake-service/.env` and set:

```env
PUBLIC_BASE_URL=https://your-deepfake-service.example.com
DEEPFAKE_SERVICE_HOST=127.0.0.1
DEEPFAKE_SERVICE_PORT=8012
DEEPFAKE_MODEL_NAME=Naman712/Deep-fake-detection
HF_TOKEN=your_huggingface_api_key_with_gated_repo_read_scope
DEEPFAKE_API_KEY=your_huggingface_api_key_with_gated_repo_read_scope
DEEPFAKE_INFERENCE_LOG_LEVEL=info
```

4. Accept the gated Hugging Face model and verify the token before starting the service. The token should have scope `Read access to contents of all public gated repos you can access`. Export the same token you put in the service `.env`, or replace `$HF_TOKEN` inline:

```bash
curl -i \
  -H "Authorization: Bearer $HF_TOKEN" \
  https://huggingface.co/Naman712/Deep-fake-detection/resolve/main/config.json
```

5. Start the service locally:

```bash
cd /var/www/your-deepfake-service
source .venv/bin/activate
.venv/bin/python -m uvicorn app:app --host 127.0.0.1 --port 8012
```

6. Verify that the service can load the model:

```bash
curl http://127.0.0.1:8012/video/health
```

7. Point the sample `.env` at that web service:

```env
DEEPFAKE_MODE=service
DEEPFAKE_SERVICE_URL=https://your-deepfake-service.example.com/video/classify
DEEPFAKE_UPLOAD_URL=https://your-deepfake-service.example.com/video/upload
DEEPFAKE_API_KEY=your_huggingface_api_key_with_gated_repo_read_scope
```

For same-machine debugging, you can point the sample directly to localhost instead:

```env
DEEPFAKE_SERVICE_URL=http://127.0.0.1:8012
```

8. If you want the service to survive reboots, create a PM2 entry and nginx proxy. Example:

```bash
pm2 start /var/www/ecosystem.config.js --only your-deepfake-service
pm2 save
sudo systemctl reload nginx
```

The PM2 entry runs:

```text
/var/www/your-deepfake-service/.venv/bin/python -m uvicorn app:app --host 127.0.0.1 --port 8012
```

and the sample then talks to the web service over `DEEPFAKE_SERVICE_URL`.

You can still start the standalone service from this sample folder via the helper script:

```bash
npm run start:deepfake-service
```

That launches:

```text
http://127.0.0.1:8012
```

Health check:

```bash
curl http://127.0.0.1:8012/video/health
```

Make sure `ffmpeg` is available:

```bash
ffmpeg -version
```

Start the sample:

```bash
npm start
```

Open the Zoom App URL in a Zoom meeting.

Recommended terminal layout:

- Terminal 1: `npm run start:deepfake-service`
- Terminal 2: `npm start`
- Terminal 3: optional `tail -f /var/www/your-deepfake-service/logs/deepfake-service.log`

## Environment Variables

```env
PORT=5050
PUBLIC_BASE_URL=https://your-domain.example.com
WEBHOOK_PATH=/webhook

ZOOM_CLIENT_ID=
ZOOM_CLIENT_SECRET=
ZOOM_SECRET_TOKEN=

MEDIA_SOCKET_CONNECTION_MODE=split
MEDIA_TYPES_FLAG=3
VIDEO_STREAM_MODE=individual
AUDIO_STREAM_MODE=multi
ALLOW_MANUAL_RTMS_USER_ID=false
VIDEO_RESOLUTION=HD
VIDEO_FPS=25
AUDIO_SEND_RATE=100

ENABLE_HLS_PREVIEW=true
FFMPEG_PATH=ffmpeg
FFMPEG_THREAD_QUEUE_SIZE=1024
HLS_SEGMENT_SECONDS=2
HLS_LIST_SIZE=6

DEEPFAKE_MODE=service
DEEPFAKE_MODEL_NAME=Naman712/Deep-fake-detection
DEEPFAKE_SERVICE_URL=https://your-deepfake-service.example.com/video/classify
DEEPFAKE_UPLOAD_URL=https://your-deepfake-service.example.com/video/upload
DEEPFAKE_API_KEY=your_huggingface_api_key_with_gated_repo_read_scope
DEEPFAKE_FRAME_FPS=5
DEEPFAKE_CLIP_SECONDS=2
DEEPFAKE_CLIP_STABLE_AGE_MS=1500
DEEPFAKE_MIN_CLIP_BYTES=4096
DEEPFAKE_INFERENCE_LOG_LEVEL=info
# Legacy fallback if DEEPFAKE_FRAME_FPS is unset:
# DEEPFAKE_SAMPLE_INTERVAL_MS=3000
DEEPFAKE_REAL_THRESHOLD=0.75
DEEPFAKE_VENDOR_NAME=Naman712/Deep-fake-detection
PYTHON_BIN=python3

AUDIO_DEEPFAKE_MODE=service
AUDIO_DEEPFAKE_MODEL_NAME=MelodyMachine/Deepfake-audio-detection-V2
AUDIO_DEEPFAKE_SERVICE_URL=https://your-deepfake-service.example.com/audio/classify
AUDIO_DEEPFAKE_API_KEY=
AUDIO_DEEPFAKE_HEALTHCHECK_ENABLED=false
AUDIO_DEEPFAKE_CLIP_SECONDS=4
AUDIO_DEEPFAKE_MAX_CLIPS=24
AUDIO_DEEPFAKE_MIN_RMS_DBFS=-65
AUDIO_DEEPFAKE_REAL_THRESHOLD=0.75
AUDIO_DEEPFAKE_VENDOR_NAME=MelodyMachine/Deepfake-audio-detection-V2

ENABLE_LAYERS_OVERLAY=true
OVERLAY_LABEL_PREFIX=Verified by

LOG_LEVEL=debug
```

## Deepfake Detection Modes

### Service mode

This is the default and recommended architecture. The backend posts MP4 clip bytes to the standalone web service.

```env
DEEPFAKE_MODE=service
DEEPFAKE_SERVICE_URL=https://your-deepfake-service.example.com/video/classify
DEEPFAKE_UPLOAD_URL=https://your-deepfake-service.example.com/video/upload
DEEPFAKE_API_KEY=your_huggingface_api_key_with_gated_repo_read_scope
DEEPFAKE_MODEL_NAME=Naman712/Deep-fake-detection
```

The same `DEEPFAKE_SERVICE_URL` also works for same-machine debugging:

```env
DEEPFAKE_SERVICE_URL=http://127.0.0.1:8012
```

If you provide only the base URL, the sample automatically expands it to `/video/classify` and uses `/video/health` for the startup probe. `/video/upload` is available for manual multipart upload tests.

The service code and runtime now live in:

```text
/var/www/your-deepfake-service
```

See that folder's README for takeover, PM2, nginx, and HF token setup.

### Audio service mode

Audio verification is intentionally separate from video verification. The backend writes selected-user RTMS PCM audio into raw `.pcm` windows and posts those PCM bytes to `AUDIO_DEEPFAKE_SERVICE_URL`.

```env
AUDIO_STREAM_MODE=multi
AUDIO_DEEPFAKE_MODE=service
AUDIO_DEEPFAKE_MODEL_NAME=MelodyMachine/Deepfake-audio-detection-V2
AUDIO_DEEPFAKE_SERVICE_URL=https://your-deepfake-service.example.com/audio/classify
AUDIO_DEEPFAKE_API_KEY=
AUDIO_DEEPFAKE_HEALTHCHECK_ENABLED=false
AUDIO_DEEPFAKE_CLIP_SECONDS=4
AUDIO_DEEPFAKE_MIN_RMS_DBFS=-65
AUDIO_DEEPFAKE_REAL_THRESHOLD=0.75
```

Expected classify request:

```text
POST /audio/classify
Content-Type: audio/L16
X-Audio-Format: pcm_s16le
X-Audio-Sample-Rate: 16000
X-Audio-Channels: 1
X-Clip-Name: rtms-user-16778240-0001.pcm
X-Zoom-User-Id: 16778240
X-Zoom-User-Name: Participant Name
X-Audio-Metadata: {"streamId":"abc","meetingId":"xyz","windowStartMs":123456}
Authorization: Bearer <AUDIO_DEEPFAKE_API_KEY or DEEPFAKE_API_KEY>
```

Body: raw RTMS participant audio only, PCM signed 16-bit little-endian, 16 kHz, mono, one participant, usually buffered for 4-10 seconds. This sample skips service calls for near-silent windows below `AUDIO_DEEPFAKE_MIN_RMS_DBFS` because silence/noise can produce misleadingly confident verification scores.

Expected response shape:

```json
{
  "label": "fake",
  "scores": {
    "real": 0.12,
    "fake": 0.88
  },
  "audioInfo": {
    "source": "rtms-user-16778240-0001.pcm",
    "sampleRate": 16000,
    "sampleCount": 64000,
    "durationSeconds": 4.0
  },
  "metadata": {
    "uploadFilename": "rtms-user-16778240-0001.pcm",
    "zoomUserId": "16778240",
    "zoomUserName": "Participant Name",
    "streamId": "abc",
    "meetingId": "xyz"
  }
}
```

The audio service uses the same bearer-key behavior as video: set `AUDIO_DEEPFAKE_API_KEY` only if you need a different key; otherwise the backend falls back to `DEEPFAKE_API_KEY`. The frontend displays audio results separately from video results.

If your audio service exposes `/audio/health`, set `AUDIO_DEEPFAKE_HEALTHCHECK_ENABLED=true`. The default is `false` because the required audio service contract is `/audio/classify`.

Set `AUDIO_DEEPFAKE_MODE=off` to keep RTMS individual audio enabled but disable audio inference calls.

### Local CLI mode

This is the older one-shot path. The backend spawns the standalone classifier for each inference clip.

```env
DEEPFAKE_MODE=local_cli
PYTHON_BIN=python3
DEEPFAKE_MODEL_NAME=Naman712/Deep-fake-detection
```

CLI path:

```text
/var/www/your-deepfake-service/classify_clip.py
```

Off:

```env
DEEPFAKE_MODE=off
```

## Runtime Flow

1. Open the Zoom App inside a Zoom Meeting.
2. Click `Start RTMS`.
3. Zoom sends `meeting.rtms_started` to the backend webhook.
4. RTMSManager connects to signaling and media sockets.
5. When `PARTICIPANT_VIDEO_ON` events arrive, the frontend dropdown populates with RTMS user IDs.
6. Select a participant from the RTMS dropdown.
7. Click `Load Individual Video`.
8. The backend sends `VIDEO_SUBSCRIPTION_REQ` through RTMSManager.
9. Selected video packets flow into ffmpeg and become `/hls/stream.m3u8`.
10. The Zoom App panel plays the HLS preview.
11. Click `Start Video Verification`.
12. The backend waits for a fresh MP4 clip under `/public/clips/` and runs deepfake detection against that clip.
13. Click `Start Audio Verification` to buffer selected-user RTMS audio into 4-second raw PCM windows under `/public/audio_clips/` and post those windows to the configured audio service.
14. The Meeting Participants list updates the selected participant's `Video:` and `Audio:` labels independently as `analyzing`, `verified`, `deepfake`, `unverified`, or `error`.
15. If a label appears beside the wrong person, select the matching Zoom participant in the optional mapping dropdown and load the individual video again.

## Guardrails

The sample follows the same startup style as `boilerplate/working_js` and adds a few demo-specific checks:

- Fails fast if `ZOOM_CLIENT_ID`, `ZOOM_CLIENT_SECRET`, or `ZOOM_SECRET_TOKEN` are missing.
- Fails fast if `MEDIA_TYPES_FLAG` does not include video.
- Fails fast if `VIDEO_STREAM_MODE` is not `individual`, because this sample is specifically for individual video.
- Fails fast if `AUDIO_STREAM_MODE` is not `multi`, because this sample verifies selected-user audio from RTMS multi-stream packets.
- Requires audio in `MEDIA_TYPES_FLAG` when HLS preview is enabled, because the ffmpeg HLS pipeline muxes video with RTMS audio.
- Blocks manual subscription to arbitrary RTMS user IDs unless that user is present in the video-on list. For testing only, set `ALLOW_MANUAL_RTMS_USER_ID=true`.
- Disables duplicate Start/Stop button clicks while a Zoom Apps SDK RTMS control call is in progress.
- Keeps the Start/Stop RTMS buttons disabled until the Zoom Apps SDK script has loaded and `getSupportedJsApis()` confirms those APIs are available.

## Files

```text
index.js                         Express, Socket.IO, webhook, RTMSManager orchestration
hlsPipeline.js                   ffmpeg HLS + rolling clip segmentation pipeline
audioClipBuffer.js               selected-user PCM audio to rolling 4-second `.pcm` windows
deepfakeClient.js                service/local_cli/off deepfake inference adapter
views/index.ejs                  Zoom App panel HTML
public/app.js                    Zoom Apps SDK + Socket.IO frontend logic
public/styles.css                frontend styles
.env.example                     configuration template
blog.md                          ignored local blog draft
```

Standalone service files now live in:

```text
/var/www/your-deepfake-service
```
