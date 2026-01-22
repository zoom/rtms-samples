# RTMS Manager Library

The `RTMSManager` is a singleton orchestration library designed to simplify the integration with Zoom's Real-Time Media Service (RTMS). It handles event sourcing (Webhooks or WebSockets), manages active media connections, and provides a unified event-driven interface for processing real-time audio, video, transcripts, and chat data.

## Features

- **Unified Event Interface**: Listen for `audio`, `video`, `transcript`, and `chat` events across multiple meetings.
- **Flexible Event Sourcing**: Supports both Webhook and WebSocket event delivery modes.
- **Automatic Connection Management**: Automatically handles RTMS handshake and socket lifecycle based on Zoom events.
- **Gap Filling & Media Alignment**: Built-in support for `enableRealTimeAudioVideoGapFiller` to ensure media streams remain synchronized even during network jitter or packet loss.
- **Configurable Media Parameters**: Fine-tune audio sample rates, video resolutions, codecs, and more.
- **Frontend Integration**: Built-in managers for serving static files and broadcasting real-time data to frontend clients via WebSockets.
- **Stream Metadata & History**: Access detailed information about active or archived streams, including start times, packet timestamps, and media configurations.

## Installation

Ensure you have the necessary dependencies installed in your project:

```bash
npm install express dotenv
```

## Quick Start

The following example demonstrates how to initialize the `RTMSManager` and listen for audio data.

```javascript
import { RTMSManager } from './library/javascript/rtmsManager/RTMSManager.js';
import { WebhookManager } from './library/javascript/rtmsManager/WebhookManager.js';
import express from 'express';
import http from 'http';

const { MEDIA_PARAMS } = RTMSManager;

// 1. Define Configuration
const rtmsConfig = {
  mediaSocketConnectionMode: 'unified',
  mediaTypesFlag: MEDIA_PARAMS.MEDIA_DATA_TYPE_ALL,
  credentials: {
    meeting: {
      clientId: process.env.ZOOM_CLIENT_ID,
      clientSecret: process.env.ZOOM_CLIENT_SECRET,
      zoomSecretToken: process.env.ZOOM_SECRET_TOKEN,
    }
  },
  mediaParams: {
    audio: {
      contentType: MEDIA_PARAMS.MEDIA_CONTENT_TYPE_RTP,
      sampleRate: MEDIA_PARAMS.AUDIO_SAMPLE_RATE_SR_16K,
      channel: MEDIA_PARAMS.AUDIO_CHANNEL_MONO,
      codec: MEDIA_PARAMS.MEDIA_PAYLOAD_TYPE_L16,
      dataOpt: MEDIA_PARAMS.MEDIA_DATA_OPTION_AUDIO_MIXED_STREAM,
      sendRate: 100,
    },
    video: {
      codec: MEDIA_PARAMS.MEDIA_PAYLOAD_TYPE_H264,
      dataOpt: MEDIA_PARAMS.MEDIA_DATA_OPTION_VIDEO_SINGLE_ACTIVE_STREAM,
      resolution: MEDIA_PARAMS.MEDIA_RESOLUTION_HD,
      fps: 25,
    },
    deskshare: {
      codec: MEDIA_PARAMS.MEDIA_PAYLOAD_TYPE_JPG,
      resolution: MEDIA_PARAMS.MEDIA_RESOLUTION_HD,
      fps: 1,
    },
    chat: {
      contentType: MEDIA_PARAMS.MEDIA_CONTENT_TYPE_TEXT,
    },
    transcript: {
      contentType: MEDIA_PARAMS.MEDIA_CONTENT_TYPE_TEXT,
      language: MEDIA_PARAMS.LANGUAGE_ID_ENGLISH,
    }
  }
};

// 2. Initialize RTMS Manager
await RTMSManager.init(rtmsConfig);

// 3. Register Event Handlers
RTMSManager.on('audio', (buffer, userId, userName, timestamp, meetingUuid) => {
  console.log(`🔊 Received ${buffer.length} bytes of audio from ${userName}`);
});

RTMSManager.on('transcript', (text, userId, userName) => {
  console.log(`💬 ${userName}: ${text}`);
});

// 4. Setup Event Sourcing (e.g., Webhooks)
const app = express();
const server = http.createServer(app);

const webhookManager = new WebhookManager({
  config: {
    webhookPath: '/webhook',
    zoomSecretToken: rtmsConfig.credentials.meeting.zoomSecretToken,
  },
  app: app
});

webhookManager.on('event', (event, payload) => {
  RTMSManager.handleEvent(event, payload);
});

webhookManager.setup();

// 5. Start the Manager
await RTMSManager.start();

server.listen(3000, () => {
  console.log('Server listening on port 3000');
});
```

## Configuration Options

The `RTMSManager.init(options)` method accepts a configuration object with the following structure:

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `mediaSocketConnectionMode` | `string` | `'unified'` | `'unified'` or `'split'` connection mode. |
| `mediaTypesFlag` | `number` | `32` | Bitmask for media types (Audio: 1, Video: 2, etc. Use `MEDIA_PARAMS.MEDIA_DATA_TYPE_ALL` for all). |
| `enableRealTimeAudioVideoGapFiller` | `boolean` | `false` | **Recommended for Recording.** Enables both jitter buffering and silence generation to ensure perfect A/V sync. |
| `credentials` | `object` | - | Zoom API credentials (Meeting, Video, S2S, WebSocket). |
| `mediaParams` | `object` | - | Detailed settings for `audio`, `video`, `deskshare`, `chat`, and `transcript`. |

### Media Parameters Constants

Access constants via `RTMSManager.MEDIA_PARAMS`:

- **Audio Sample Rates**: `AUDIO_SAMPLE_RATE_SR_8K`, `SR_16K`, `SR_32K`, `SR_48K`
- **Codecs**: `MEDIA_PAYLOAD_TYPE_L16` (PCM), `OPUS`, `H264`, `JPG`
- **Resolutions**: `MEDIA_RESOLUTION_SD`, `HD`, `FHD`

## Events

The `RTMSManager` emits the following events:

### Media Events
- `audio`: `(buffer, userId, userName, timestamp, meetingUuid, streamId, rtmsType)`
- `video`: `(buffer, userId, userName, timestamp, meetingUuid, streamId, rtmsType)`
- `transcript`: `(text, userId, userName, timestamp, meetingUuid, streamId, rtmsType, ...)`
- `chat`: `(text, userId, userName, timestamp, meetingUuid, streamId, rtmsType)`

### Lifecycle Events
- `meeting.rtms_started` / `meeting.rtms_stopped`: Lifecycle events for meeting streams.
- `session.rtms_started` / `session.rtms_stopped`: Lifecycle events for Video SDK sessions.
- `stream_state_changed`: When a media stream starts or stops.
- `session_state_changed`: When the RTMS session state changes.

### Meeting Events (Built-in)

The library has **built-in support for real-time meeting events**. Subscribe to the `event` handler to receive notifications about meeting dynamics:

```javascript
RTMSManager.on('event', (eventData, meetingUuid, streamId, rtmsType) => {
  switch (eventData.event_type) {
    case 1:
      console.log('First packet capture timestamp received');
      break;
    case 2:
      console.log(`Active speaker changed to: ${eventData.user_name} (${eventData.user_id})`);
      break;
    case 3:
      console.log(`Participant joined: ${eventData.user_name} (${eventData.user_id})`);
      break;
    case 4:
      console.log(`Participant left: ${eventData.user_name} (${eventData.user_id})`);
      break;
  }
});
```

| Event Type | Code | Description |
|------------|------|-------------|
| First Packet Capture | `1` | Timestamp when first media packet was captured |
| Active Speaker Changed | `2` | Notifies when the active speaker changes |
| Participant Joined | `3` | A participant joined the meeting |
| Participant Left | `4` | A participant left the meeting |

### Stream State Events

Monitor stream health and state changes:

```javascript
RTMSManager.on('stream_state_changed', (msg, meetingUuid, streamId, rtmsType) => {
  // msg.state: 0=Inactive, 1=Active, 2=Interrupted, 3/4=Terminating
  // msg.stop_reason: See stop reason codes below
});

RTMSManager.on('session_state_changed', (msg, meetingUuid, streamId, rtmsType) => {
  // msg.state: 2=Started, 3=Paused, 4=Resumed, 5=Stopped
});
```

**Stop Reason Codes** (available in `msg.stop_reason`):
| Code | Reason |
|------|--------|
| 1 | Host triggered stop |
| 2 | User triggered stop |
| 3 | User left meeting |
| 4 | User was ejected |
| 5 | App disabled by host |
| 6 | Meeting ended |
| 7-18 | Various connection/system reasons (see root README for full list) |

## Advanced Usage

### Real-Time Media Synchronization
For recording or high-fidelity processing, enable the `enableRealTimeAudioVideoGapFiller`. This ensures that the media stream remains smooth and perfectly synchronized, even if packets are lost or arrive out of order.

- **Smoothness**: It reorders jittery packets so audio doesn't sound "choppy."
- **Timing**: It generates "silent" data during network drops so the recording duration matches the actual meeting time.

```javascript
await RTMSManager.init({
  enableRealTimeAudioVideoGapFiller: true,
  // ... other config
});
```

### Accessing Stream Metadata
You can retrieve detailed information about a stream using its `streamId`.

```javascript
RTMSManager.on('audio', (buffer, userId, userName, timestamp, rtmsId, streamId) => {
  const audioDetails = RTMSManager.getAudioDetails(streamId);
  const metadata = RTMSManager.getStreamMetadata(streamId);
  
  console.log(`Stream Start Time: ${metadata.startTime}`);
  console.log(`Audio Codec: ${audioDetails.codec}`);
});
```

### Handling Lifecycle Events
You can listen for specific Zoom events to trigger post-processing, such as muxing audio and video after a meeting ends.

```javascript
RTMSManager.on('meeting.rtms_stopped', async (payload) => {
  const { meeting_uuid, rtms_stream_id } = payload;
  console.log(`Meeting ${meeting_uuid} ended. Starting post-processing...`);
  // Trigger your FFmpeg muxing logic here
});
```

## Architecture

The library is organized into four main modules:

- **`rtmsManager/`**: The core singleton that manages the lifecycle of media connections and orchestrates data flow.
- **`webhookManager/`**: Ingests events from Zoom via Webhooks and feeds them into the `RTMSManager`.
- **`webSocketManager/`**: Ingests events from Zoom via WebSockets and feeds them into the `RTMSManager`.
- **`commonHelpers/`**: A collection of shared utilities for audio, video, and network processing, managed by the `HelperManager`.

## Common Helpers

The library includes a set of common utility helpers located in `/library/javascript/commonHelpers/`. You can import all helpers at once using the `HelperManager`:

```javascript
import { HelperManager } from './commonHelpers/HelperManager.js';

// Use audio helpers
HelperManager.audio.saveRawAudio(...);

// Use network helpers
HelperManager.network.ServerPinger.ping(...);

// Use filename helpers
HelperManager.filename.sanitize(...);
```

### Audio Helpers (`./commonHelpers/audio/audioHelper.js`)
- **`PCMAnalyzer`**: Class for analyzing raw PCM audio data (e.g., calculating volume levels).
- **`saveRawAudio`**: Function to save raw PCM audio chunks to disk.
- **`convertRawToWav`**: Function to convert raw PCM audio to WAV format.
- **`mergeAudioFiles`**: Function to merge multiple audio files into one.

### Video Helpers (`./commonHelpers/video/videoHelper.js`)
- **`H264StreamAnalyzer`**: Class for analyzing H.264 video streams (resolution, frame types, FPS, lost frame detection).
- **`saveRawVideo`**: Function to save raw H.264 video frames to disk.
- **`convertH264ToMp4`**: Function to convert raw H.264 video to MP4 format.
- **`createVideoGrid`**: Function to combine multiple video files into a grid layout.

#### H264StreamAnalyzer

Parses H.264 NAL units to extract stream metadata in real-time:

```javascript
import { H264StreamAnalyzer } from './commonHelpers/video/videoHelper.js';

const analyzer = new H264StreamAnalyzer({
  logInterval: 1,
  statsInterval: 100,
  enableDetailedLogging: false,
  enableConsoleOutput: true
});

RTMSManager.on('video', ({ buffer, timestamp }) => {
  const streamInfo = analyzer.processBuffer(buffer, timestamp);
  // streamInfo.resolution: { width, height }
  // streamInfo.fps: calculated FPS
  // streamInfo.frameTypeStats: { I: n, P: n, B: n }
  // streamInfo.totalFrames: frame count
});

RTMSManager.on('meeting.rtms_started', () => analyzer.reset());
```

| Option | Default | Description |
|--------|---------|-------------|
| `logInterval` | 1 | Log every N frames |
| `statsInterval` | 1 | Show detailed stats every N frames |
| `enableDetailedLogging` | false | Log NAL unit parsing details |
| `enableConsoleOutput` | true | Enable console logging |

| Method | Description |
|--------|-------------|
| `processFrame(base64Data, timestamp)` | Process base64-encoded H.264 data |
| `processBuffer(buffer, timestamp)` | Process raw Buffer directly |
| `getStreamInfo()` | Get current stream metadata |
| `reset()` | Reset analyzer state |

### Audio-Video Helpers (`./commonHelpers/audiovideo/audiovideoHelper.js`)
- **`muxAudioVideo`**: Function to mux audio and video files into a single MP4.
- **`convertMeetingMedia`**: Function to automate the conversion of all raw media files in a meeting folder.
- **`muxIndividualAudioVideo`**: Function to mux matching individual user audio and video files.
- **`muxMixedAudioVideo`**: Function to mux mixed audio and video combinations.
- **`mergeIndividualAudio`**: Function to merge all individual user audio files.
- **`mergeIndividualVideo`**: Function to combine individual user video files into a grid.
- **`muxMixedCombinationOfAudioAndVideo`**: Function to mux various combinations of mixed and individual media.

### Filename Helpers (`./commonHelpers/filename/UUIDHelper.js`)
- **`UUIDHelper`**: Utility for sanitizing and managing meeting UUIDs for file storage.

### Network Helpers (`./commonHelpers/network/networkHelper.js`)
- **`ServerPinger`**: Utility for pinging Zoom media servers to measure latency and ensure connectivity.

### Gap Filler Utilities (`./commonHelpers/gapfiller/`)

Standalone utilities for handling media gaps during mute or network issues. These are separate from RTMSManager and can be used independently after receiving media events.

#### VideoGapFiller
Time-based mute detection using wall clock time. Best for streaming scenarios.

```javascript
import { VideoGapFiller } from './commonHelpers/HelperManager.js';

const videoFiller = new VideoGapFiller({ fps: 25, gapThreshold: 320 });

videoFiller.on('data', ({ buffer, timestamp, isFiller }) => {
  // Process video (real or filler)
});

videoFiller.start();

RTMSManager.on('video', ({ buffer, timestamp }) => {
  videoFiller.push(buffer, timestamp);
});
```

| Option | Default | Description |
|--------|---------|-------------|
| `fps` | 25 | Frames per second |
| `gapThreshold` | 320 | Milliseconds before mute detection triggers |

#### VideoJitterBuffer
Timestamp-based jitter buffer using packet timestamps. Best for recording scenarios where timing precision matters.

```javascript
import { VideoJitterBuffer } from './commonHelpers/HelperManager.js';

const videoBuffer = new VideoJitterBuffer({ fps: 25, tolerance: 60 });

videoBuffer.on('data', ({ buffer, timestamp, isFiller }) => {
  // Process video (real or filler)
});

videoBuffer.start();

RTMSManager.on('video', ({ buffer, timestamp }) => {
  videoBuffer.push(buffer, timestamp);
});
```

| Option | Default | Description |
|--------|---------|-------------|
| `fps` | 25 | Frames per second |
| `tolerance` | 60 | Max timestamp difference (ms) before filling gap |

#### AudioGapFiller
Time-based audio gap filler. Note: Most use cases don't require audio gap filling since Zoom sends silent buffers during mute.

```javascript
import { AudioGapFiller } from './commonHelpers/HelperManager.js';

const audioFiller = new AudioGapFiller({ sampleRate: 16000, frameDuration: 20, gapThreshold: 100 });

audioFiller.on('data', ({ buffer, timestamp, isFiller }) => {
  // Process audio (real or filler)
});

audioFiller.start();

RTMSManager.on('audio', ({ buffer, timestamp }) => {
  audioFiller.push(buffer, timestamp);
});
```

| Option | Default | Description |
|--------|---------|-------------|
| `sampleRate` | 16000 | Audio sample rate in Hz |
| `frameDuration` | 20 | Frame duration in milliseconds |
| `gapThreshold` | 100 | Milliseconds before gap filling triggers |

#### Choosing the Right Filler

| Use Case | Recommended | Why |
|----------|-------------|-----|
| Live Streaming | `VideoGapFiller` | Wall clock timing matches stream playback |
| Recording | `VideoJitterBuffer` | Packet timestamps ensure accurate A/V sync |
| Audio | None (direct save) | Zoom sends silent buffers during mute |

### Webhook Manager (`./webhookManager/WebhookManager.js`)
- **`WebhookManager`**: Handles incoming Zoom webhooks, validates signatures, and emits events to the `RTMSManager`.

### WebSocket Manager (`./webSocketManager/WebsocketManager.js`)
- **`WebsocketManager`**: Connects to Zoom's WebSocket event service to receive real-time events, which are transmitted to `RTMSManager`'.
