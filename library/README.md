# RTMS Library

Helper libraries for Zoom's Real-Time Media Streams (RTMS) API. Available in JavaScript and Python.

## Quick Start

### JavaScript

```javascript
import { RTMSManager } from './javascript/rtmsManager/index.js';

// Initialize with credentials
await RTMSManager.init({
  credentials: {
    meeting: {
      clientId: process.env.ZOOM_CLIENT_ID,
      clientSecret: process.env.ZOOM_CLIENT_SECRET,
      secretToken: process.env.ZOOM_SECRET_TOKEN,
    }
  },
  mediaTypes: RTMSManager.MEDIA.AUDIO | RTMSManager.MEDIA.TRANSCRIPT
});

// Handle media events
RTMSManager.on('audio', ({ buffer, userName }) => {
  console.log(`Audio from ${userName}: ${buffer.length} bytes`);
});

RTMSManager.on('transcript', ({ text, userName }) => {
  console.log(`${userName}: ${text}`);
});

// Feed webhook events
RTMSManager.handleEvent('meeting.rtms_started', webhookPayload);
```

### Python

```python
from library.python.rtms_manager import RTMSManager, MediaType

rtms = await RTMSManager.init({
    'credentials': {
        'meeting': {
            'client_id': os.environ['ZOOM_CLIENT_ID'],
            'client_secret': os.environ['ZOOM_CLIENT_SECRET'],
            'secret_token': os.environ['ZOOM_SECRET_TOKEN'],
        }
    },
    'media_types': MediaType.AUDIO | MediaType.TRANSCRIPT
})

rtms.on('audio', lambda data: print(f"Audio: {len(data['buffer'])} bytes"))
rtms.on('transcript', lambda data: print(f"{data['user_name']}: {data['text']}"))
```

## Media Types

| Flag | JavaScript | Python | Description |
|------|------------|--------|-------------|
| 1 | `MEDIA.AUDIO` | `MediaType.AUDIO` | Raw audio streams |
| 2 | `MEDIA.VIDEO` | `MediaType.VIDEO` | H.264 video frames |
| 4 | `MEDIA.SHARESCREEN` | `MediaType.SHARESCREEN` | Screen share |
| 8 | `MEDIA.TRANSCRIPT` | `MediaType.TRANSCRIPT` | Real-time transcription |
| 16 | `MEDIA.CHAT` | `MediaType.CHAT` | Chat messages |
| 32 | `MEDIA.ALL` | `MediaType.ALL` | All media types |

Combine with bitwise OR: `MEDIA.AUDIO | MEDIA.TRANSCRIPT`

## Presets (JavaScript)

```javascript
// Audio optimized for speech processing
await RTMSManager.init({ ...RTMSManager.PRESETS.AUDIO_ONLY, credentials });

// Audio + transcript for captions
await RTMSManager.init({ ...RTMSManager.PRESETS.TRANSCRIPTION, credentials });

// Audio + video for recording
await RTMSManager.init({ ...RTMSManager.PRESETS.VIDEO_RECORDING, credentials });

// All media types
await RTMSManager.init({ ...RTMSManager.PRESETS.FULL_MEDIA, credentials });
```

## Events

### Media Events

All media events include: `buffer` (or `text`), `userId`, `userName`, `timestamp`, `meetingId`, `streamId`, `productType`

```javascript
RTMSManager.on('audio', (data) => { /* data.buffer */ });
RTMSManager.on('video', (data) => { /* data.buffer */ });
RTMSManager.on('sharescreen', (data) => { /* data.buffer */ });
RTMSManager.on('transcript', (data) => { /* data.text */ });
RTMSManager.on('chat', (data) => { /* data.text */ });
```

### Lifecycle Events

```javascript
RTMSManager.on('meeting.rtms_started', (payload) => { /* New stream */ });
RTMSManager.on('meeting.rtms_stopped', (payload) => { /* Stream ended */ });
RTMSManager.on('session.rtms_started', (payload) => { /* Video SDK */ });
RTMSManager.on('stream_state_changed', (msg, meetingUuid, streamId, type) => {});
RTMSManager.on('error', (error) => { /* RTMSError with cause/fix */ });
```

## Configuration

```javascript
await RTMSManager.init({
  // Required
  credentials: {
    meeting: { clientId, clientSecret, secretToken },
    videoSdk: { clientId, clientSecret, secretToken },  // Optional
  },
  
  // Optional
  mediaTypes: RTMSManager.MEDIA.ALL,  // Default: ALL
  logging: 'info',                     // 'off'|'error'|'warn'|'info'|'debug'
  logDir: '/var/log/rtms',            // Log file directory
  useUnifiedMediaSocket: false,        // Single socket for all media
  enableGapFilling: false,             // Fill gaps in recordings
});
```

---

## Helper Classes

### WebhookManager (Python)

Handles Zoom webhook events with automatic signature validation and framework integration.

```python
from library.python.webhook_manager import WebhookManager

webhook = WebhookManager(
    webhook_path='/webhook',
    zoom_secret_token='YOUR_SECRET_TOKEN',
    video_secret_token='YOUR_VIDEO_SECRET_TOKEN'  # Optional, for Video SDK
)

# Auto-setup with Flask
webhook.setup_flask(app, rtms_manager)

# Or with FastAPI
webhook.setup_fastapi(app, rtms_manager)

# Or handle events manually
webhook.on_event(lambda event, payload: print(f'{event}: {payload}'))
```

**Features:**
- Automatic `endpoint.url_validation` challenge response
- Signature validation for webhook security
- Critical event logging (`rtms.concurrency_limited`, `rtms.start_failed`, etc.)
- One-line integration with Flask or FastAPI

---

### FrontendWssManager

WebSocket server for broadcasting real-time data to browser clients. Useful for building live dashboards, caption displays, or meeting visualizations.

#### JavaScript

```javascript
import { FrontendWssManager } from './javascript/rtmsManager/FrontendWssManager.js';

const frontendWss = new FrontendWssManager({
  server: httpServer,
  config: {
    frontendWssPath: '/ws',
    frontendWssEnabled: true
  }
});
frontendWss.setup();

// Broadcast to all connected clients
frontendWss.broadcast({ type: 'transcript', text: 'Hello world' });

// Broadcast to specific meeting
frontendWss.broadcastToMeeting(meetingUUID, { type: 'update', data: {...} });

// Broadcast to specific user in a meeting
frontendWss.broadcastToUser(meetingUUID, userID, { type: 'private', data: {...} });
```

#### Python

```python
from library.python.frontend_manager import FrontendWssManager

frontend_wss = FrontendWssManager(wss_path='/ws', ping_interval=10)

# Broadcast methods
frontend_wss.broadcast({'type': 'transcript', 'text': '...'})
frontend_wss.broadcast_to_meeting(meeting_uuid, {'type': 'update'})
frontend_wss.broadcast_to_user(meeting_uuid, user_id, {'type': 'private'})
```

**Features:**
- Client registration with `meetingUUID` and `userID`
- Auto-disconnect unregistered clients after 15s timeout
- Keep-alive ping/pong every 10s
- Targeted broadcasting (all clients, per-meeting, per-user)
- Graceful shutdown with connection cleanup

**Client Registration Protocol:**

```javascript
// Browser client connects and registers
const ws = new WebSocket('wss://your-server.com/ws');

ws.onopen = () => {
  ws.send(JSON.stringify({
    type: 'register',
    meetingUUID: 'abc123',
    userID: 'user456'
  }));
};

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  if (data.type === 'registration_success') {
    console.log('Registered!');
  }
  if (data.type === 'ping') {
    ws.send(JSON.stringify({ type: 'pong' }));
  }
};
```

---

### FrontendManager (JavaScript)

Express.js middleware for serving static frontend files with automatic WebSocket URL injection.

```javascript
import { FrontendManager } from './javascript/rtmsManager/FrontendManager.js';

const frontendManager = new FrontendManager({
  app: expressApp,
  config: {
    port: 3000,
    viewsPath: './public/views',
    staticPath: './public',
    frontendWssPath: '/ws',
    frontendWssUrl: 'wss://your-domain.com/ws'  // Optional, auto-generated if not set
  }
});
frontendManager.setup();
```

**Features:**
- Serves static files from configured directory
- EJS template rendering with WebSocket URL injection
- Auto-detects HTTPS and generates correct `wss://` URLs
- Works behind reverse proxies (reads `x-forwarded-proto`)

---

## Utilities

### FileLogger

Configurable logger with file output, log levels, and buffered writes for performance.

```javascript
import { FileLogger } from './javascript/rtmsManager/utils/FileLogger.js';

// Set log level: 'off' | 'error' | 'warn' | 'info' | 'debug'
FileLogger.setLevel('info');

// Set log directory (creates hourly rotating files: rtms_2024-01-15_14.log)
FileLogger.setLogDir('/var/log/rtms');

// Log at different levels
FileLogger.debug('Verbose debugging info');
FileLogger.info('General information');
FileLogger.warn('Warning message');
FileLogger.error('Error occurred');

// Control output destinations
FileLogger.setConsoleOutput(true);   // Enable/disable console
FileLogger.setFileOutput(true);      // Enable/disable file writing
```

**Features:**
- Log levels: `off` < `error` < `warn` < `info` < `debug`
- Hourly rotating log files
- Buffered writes (flushes every 100ms or 50 entries)
- Graceful shutdown with sync flush on SIGINT/SIGTERM
- JSON serialization for objects

---

### RTMSError

Developer-friendly error class with causes, fixes, and documentation links.

```javascript
import { RTMSError, ZOOM_STATUS_CODES } from './javascript/rtmsManager/utils/RTMSError.js';

// Create from Zoom status code
const error = RTMSError.fromZoomStatus(1, { meetingId: 'abc123' });

// Create from SDK error code
const initError = RTMSError.fromCode('NOT_INITIALIZED');

// Pretty-print with causes and fixes
console.log(error.toString());
// Output:
// ============================================================
// RTMSError: Signature validation failed
// ============================================================
//
//    Code: INVALID_SIGNATURE (Zoom status: 1)
//    Category: auth
//    Meeting: abc123
//
//    Possible causes:
//    1. clientSecret does not match clientId
//    2. Using Meeting SDK credentials for Video SDK (or vice versa)
//    ...
//
//    How to fix:
//    1. Verify clientId and clientSecret match in Zoom Marketplace
//    ...
//
//    Docs: https://developers.zoom.us/docs/rtms/auth/
// ============================================================

// Access error details
error.code;      // 'INVALID_SIGNATURE'
error.category;  // 'auth'
error.causes;    // ['clientSecret does not match...', ...]
error.fixes;     // ['Verify clientId and clientSecret...', ...]
error.docsUrl;   // 'https://developers.zoom.us/docs/rtms/auth/'
```

**Zoom Status Codes:**
| Code | Name | Category |
|------|------|----------|
| 0 | SUCCESS | success |
| 1 | INVALID_SIGNATURE | auth |
| 2 | INVALID_CLIENT_ID | auth |
| 5 | MEETING_NOT_FOUND | meeting |
| 8 | PERMISSION_DENIED | permission |
| 15 | HANDSHAKE_FAILED | auth |
| 19 | DUPLICATE_CONNECTION | connection |
| 20 | MAX_CONNECTIONS | limit |

**SDK Error Codes:** `NOT_INITIALIZED`, `MISSING_CREDENTIALS`, `INVALID_CONFIG`, `CONNECTION_FAILED`, `SIGNALING_ERROR`, `MEDIA_ERROR`

---

### ActiveConnectionManager

Manages active RTMS stream connections with lookup by streamId or meetingId.

```javascript
import { ActiveConnectionManager } from './javascript/rtmsManager/ActiveConnectionManager.js';

const manager = new ActiveConnectionManager();

// Add/remove connections
manager.add(streamId, handler);
manager.remove(streamId);

// Lookup
manager.has(streamId);           // true/false
manager.get(streamId);           // handler or null
manager.findByRtmsId(meetingId); // Find by meeting UUID

// Iterate
manager.getAll();  // Array of all handlers
manager.size;      // Number of active connections
manager.clear();   // Remove all
```

---

### signatureHelper

Generate HMAC-SHA256 signatures for RTMS authentication.

```javascript
import { generateRTMSSignature } from './javascript/rtmsManager/utils/signatureHelper.js';

const signature = generateRTMSSignature(
  meetingUuid,   // From webhook payload
  streamId,      // From webhook payload
  clientId,      // Your Zoom app client ID
  clientSecret   // Your Zoom app client secret
);
// Returns: hex-encoded HMAC-SHA256 of "clientId,meetingUuid,streamId"
```

---

## Advanced Features

This library wraps the raw RTMS WebSocket protocol (see [RTMS_CONNECTION_FLOW.md](../RTMS_CONNECTION_FLOW.md)) and adds production-ready features on top.

### What the Library Handles For You

| Raw Protocol (DIY) | This Library |
|--------------------|--------------|
| Manual WebSocket connection | Automatic connection on webhook |
| Manual HMAC signature generation | Automatic signing |
| Manual keep-alive ping/pong | Automatic keep-alive |
| Connection drops = data loss | Automatic reconnection with 3s backoff |
| Single socket = all media fails together | Split sockets per media type |
| Raw state codes (0, 1, 2...) | Human-readable state names |
| Manual timestamp tracking | Automatic first/last packet tracking |
| Gaps in recording = silence missing | Optional gap filling with silent frames |

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              YOUR APPLICATION                               │
│                                                                             │
│   RTMSManager.on('audio', ...)   RTMSManager.on('transcript', ...)         │
│                 │                              │                            │
└─────────────────┼──────────────────────────────┼────────────────────────────┘
                  │                              │
                  ▼                              ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                             RTMSManager (singleton)                         │
│                                                                             │
│   • Event emitter interface          • Multi-product support                │
│   • Connection lifecycle             • Stream history (LRU cache)           │
│   • Credential management            • Error handling with causes/fixes     │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
                  │
                  │ one per active meeting/session
                  ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                        RTMSMessageHandler (per stream)                      │
│                                                                             │
│   • Owns signaling socket            • Owns media sockets (1 per type)      │
│   • Reconnection logic               • Gap filling (optional)               │
│   • Timestamp tracking               • State management                     │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
                  │
        ┌─────────┼─────────┬─────────┬─────────┐
        ▼         ▼         ▼         ▼         ▼
    ┌───────┐ ┌───────┐ ┌───────┐ ┌───────┐ ┌───────┐
    │Signal │ │ Audio │ │ Video │ │Share  │ │Trans/ │
    │Socket │ │Socket │ │Socket │ │Socket │ │Chat   │
    └───────┘ └───────┘ └───────┘ └───────┘ └───────┘
        │         │         │         │         │
        └─────────┴─────────┴─────────┴─────────┘
                          │
                          ▼
                    Zoom RTMS Servers
```

---

### Connection Lifecycle

```
Webhook received          Signaling            Media                You receive
─────────────────────────────────────────────────────────────────────────────────

meeting.rtms_started ──▶ Connect ──▶ Handshake ──▶ Get media URL
                                                        │
                                                        ▼
                                                   Connect ──▶ Handshake
                                                        │
                                                        ▼
                                                   Send START to signaling
                                                        │
                                                        ▼
                              ┌──────────────────────────┘
                              │
                              ▼
                         Data flows ─────────────────────────▶ 'audio' events
                              │                               'video' events
                              │                               'transcript' events
                              │
    [connection drop] ◀──────┤
                              │
                              ▼
                         Wait 3s, reconnect
                              │
                              ▼
                         Data resumes ───────────────────────▶ events continue
                              │
                              │
meeting.rtms_stopped ──▶ Cleanup ────────────────────────────▶ stream archived
```

---

### Socket States

**Signaling:** `connecting` → `authenticated` → `ready` → `closed`

**Media:** `connecting` → `authenticated` → `streaming` → `closed`

```javascript
// Access current state
handler.signaling.state;      // 'ready'
handler.media.audio.state;    // 'streaming'
handler.media.video.state;    // 'streaming'
```

---

### Automatic Reconnection

When a socket drops, the library automatically reconnects:

- **Media socket drops, signaling OK** → Reconnect only the media socket
- **Signaling drops** → Reconnect both signaling and all media sockets
- **3 second backoff** between attempts
- **Stops reconnecting** on: `rtms_stopped` webhook, manual `stop()`, or auth failure

```javascript
// Manual control
handler.shouldReconnect = false;  // Disable auto-reconnect
handler.stop();                   // Graceful shutdown
```

---

### Split Media Sockets

Each media type (audio, video, transcript, etc.) gets its own WebSocket:

- Audio reconnects independently of video
- Transcript failure doesn't affect audio recording
- Better fault isolation for production

---

### Gap Filling (Recording)

For continuous recordings, enable gap filling to insert silence during network drops:

```javascript
await RTMSManager.init({
  credentials: {...},
  enableGapFilling: true
});
```

```
Packets received:  [A1] [A2] [--] [--] [A5] [A6]
                          ↓   ↓
Output with fill:  [A1] [A2] [silence] [silence] [A5] [A6]
```

---

### State Code Helpers

Decode Zoom's numeric codes to human-readable strings:

```javascript
import { getRtmsStreamState, getRtmsStopReason } from './utils/rtmsEventLookupHelper.js';

getRtmsStreamState(1);   // 'Stream state: ACTIVE (media is being transmitted)'
getRtmsStreamState(2);   // 'Stream state: INTERRUPTED (connection issue detected)'
getRtmsStopReason(6);    // 'RTMS stopped: Meeting ended (STOP_BC_MEETING_ENDED)'
getRtmsStopReason(8);    // 'RTMS stopped: Stream revoked — delete assets immediately'
```

---

### Stream Metadata API

Access metadata for active or archived streams:

```javascript
RTMSManager.getStreamTimestamps(streamId);  // { firstPacketTimestamp, lastPacketTimestamp }
RTMSManager.getStreamStartTime(streamId);   // webhook event_ts
RTMSManager.getStreamMetadata(streamId);    // full metadata object
RTMSManager.getAudioDetails(streamId);      // { sample_rate, channel, codec, ... }
RTMSManager.getVideoDetails(streamId);      // { codec, resolution, fps, ... }
```

Archived streams are kept in an LRU cache (default: 100 streams).

---

## Architecture

```
library/
├── javascript/
│   └── rtmsManager/
│       ├── index.js              # Entry point & exports
│       ├── RTMSManager.js        # Main singleton class
│       ├── RTMSMessageHandler.js # Per-stream handler
│       ├── signalingSocket.js    # Signaling WebSocket
│       ├── mediaSocket.js        # Media WebSocket
│       ├── FrontendWssManager.js # Client broadcast
│       ├── processors/           # Media type processors
│       └── utils/
│           ├── rtmsMediaParams.js   # Codec/format constants
│           ├── RTMSFlagHelper.js    # Media type flags
│           ├── RTMSError.js         # Error handling
│           └── signatureHelper.js   # HMAC signatures
│
└── python/
    ├── rtms_manager/
    │   ├── rtms_manager.py       # Main class
    │   ├── signaling_socket.py   # Signaling WebSocket
    │   ├── media_socket.py       # Media WebSocket
    │   └── utils/
    ├── webhook_manager/          # Flask/FastAPI webhook handler
    └── frontend_manager/         # WebSocket broadcast
```

## See Also

- [MEDIA_PARAMETERS.md](../MEDIA_PARAMETERS.md) - Detailed codec and format options
- [RTMS_CONNECTION_FLOW.md](../RTMS_CONNECTION_FLOW.md) - Protocol sequence diagrams
- [TROUBLESHOOTING.md](../TROUBLESHOOTING.md) - Common issues and fixes
- [Python README](./python/README.md) - Python-specific details
