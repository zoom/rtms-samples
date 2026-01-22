# RTMS Manager - Python Library

Python equivalent of the JavaScript RTMSManager library for Zoom's Real-Time Media Streams (RTMS).

## Installation

```bash
pip install -r requirements.txt
```

## Quick Start

```python
import asyncio
from library.python.rtms_manager import RTMSManager, MediaType
from library.python.webhook_manager import WebhookManager

async def main():
    # Initialize RTMSManager
    rtms = await RTMSManager.init({
        'credentials': {
            'meeting': {
                'client_id': 'YOUR_CLIENT_ID',
                'client_secret': 'YOUR_CLIENT_SECRET',
                'secret_token': 'YOUR_SECRET_TOKEN',
            }
        },
        'media_types': MediaType.AUDIO | MediaType.TRANSCRIPT,
        'logging': 'info',
    })

    # Register event handlers
    rtms.on('audio', lambda data: print(f"Audio: {len(data['buffer'])} bytes from {data['user_name']}"))
    rtms.on('transcript', lambda data: print(f"Transcript: {data['user_name']}: {data['text']}"))

    # Setup webhook (Flask example)
    from flask import Flask
    app = Flask(__name__)
    
    webhook = WebhookManager(
        webhook_path='/webhook',
        zoom_secret_token='YOUR_SECRET_TOKEN'
    )
    webhook.setup_flask(app, rtms)

    # Run
    app.run(port=3000)

asyncio.run(main())
```

## With FastAPI

```python
import asyncio
from fastapi import FastAPI
from library.python.rtms_manager import RTMSManager, MediaType
from library.python.webhook_manager import WebhookManager

app = FastAPI()
rtms = None

@app.on_event("startup")
async def startup():
    global rtms
    rtms = await RTMSManager.init({
        'credentials': {
            'meeting': {
                'client_id': 'YOUR_CLIENT_ID',
                'client_secret': 'YOUR_CLIENT_SECRET',
                'secret_token': 'YOUR_SECRET_TOKEN',
            }
        },
        'media_types': MediaType.AUDIO | MediaType.TRANSCRIPT,
    })

    rtms.on('transcript', lambda data: print(f"{data['user_name']}: {data['text']}"))

    webhook = WebhookManager(
        webhook_path='/webhook',
        zoom_secret_token='YOUR_SECRET_TOKEN'
    )
    webhook.setup_fastapi(app, rtms)

@app.on_event("shutdown")
async def shutdown():
    if rtms:
        await rtms.stop()
```

## Configuration Options

```python
await RTMSManager.init({
    # Credentials (required)
    'credentials': {
        'meeting': {
            'client_id': str,
            'client_secret': str,
            'secret_token': str,
        },
        'video_sdk': {  # Optional - for Video SDK
            'client_id': str,
            'client_secret': str,
            'secret_token': str,
        }
    },
    
    # Media types to subscribe (default: MediaType.ALL)
    'media_types': MediaType.AUDIO | MediaType.VIDEO | MediaType.TRANSCRIPT,
    
    # Logging level: 'off', 'error', 'warn', 'info', 'debug'
    'logging': 'info',
    
    # Log directory (optional)
    'log_dir': '/var/log/rtms',
    
    # Use single WebSocket for all media types (default: False)
    'use_unified_media_socket': False,
    
    # Enable gap filling for recordings (default: False)
    'enable_gap_filling': False,
})
```

## Media Type Flags

```python
from library.python.rtms_manager import MediaType

MediaType.AUDIO        # 1 - Audio streams
MediaType.VIDEO        # 2 - Video streams
MediaType.SHARESCREEN  # 4 - Screen share
MediaType.TRANSCRIPT   # 8 - Real-time transcription
MediaType.CHAT         # 16 - Chat messages
MediaType.ALL          # 32 - All media types
```

## Events

### Media Events

```python
rtms.on('audio', lambda data: ...)
# data = {
#     'buffer': bytes,      # Raw audio data
#     'user_id': str,
#     'user_name': str,
#     'timestamp': int,
#     'meeting_id': str,
#     'stream_id': str,
#     'product_type': str,  # 'meeting', 'video_sdk', etc.
# }

rtms.on('video', lambda data: ...)
rtms.on('sharescreen', lambda data: ...)
rtms.on('transcript', lambda data: ...)  # data['text'] instead of buffer
rtms.on('chat', lambda data: ...)        # data['text'] instead of buffer
```

### Lifecycle Events

```python
rtms.on('meeting.rtms_started', lambda payload: ...)
rtms.on('meeting.rtms_stopped', lambda payload: ...)
rtms.on('session.rtms_started', lambda payload: ...)  # Video SDK
rtms.on('session.rtms_stopped', lambda payload: ...)
rtms.on('stream_state_changed', lambda msg, meeting_uuid, stream_id, rtms_type: ...)
rtms.on('error', lambda error: ...)
```

## WebhookManager

Handles Zoom webhook events and validates webhook signatures.

```python
from library.python.webhook_manager import WebhookManager

webhook = WebhookManager(
    webhook_path='/webhook',
    zoom_secret_token='YOUR_SECRET_TOKEN',
    video_secret_token='YOUR_VIDEO_SECRET_TOKEN',  # Optional
)

# Manual event handling
webhook.on_event(lambda event, payload: rtms.handle_event(event, payload))

# Or auto-setup with Flask/FastAPI
webhook.setup_flask(app, rtms)
webhook.setup_fastapi(app, rtms)
```

## FrontendWssManager

Broadcasts real-time data to frontend WebSocket clients.

```python
from library.python.frontend_manager import FrontendWssManager

frontend_wss = FrontendWssManager(wss_path='/ws')

# Broadcast to all connected clients
frontend_wss.broadcast({'type': 'transcript', 'text': '...'})

# Broadcast to specific meeting
frontend_wss.broadcast_to_meeting(meeting_uuid, {'type': 'update', ...})

# Broadcast to specific user
frontend_wss.broadcast_to_user(meeting_uuid, user_id, {'type': 'private', ...})
```

## Comparison with JavaScript Library

| Feature | JavaScript | Python |
|---------|------------|--------|
| Async/Await | ES Modules | asyncio |
| WebSocket | ws | websockets |
| HTTP Framework | Express | Flask/FastAPI |
| Event Emitter | Node.js EventEmitter | Custom implementation |
| Singleton | Class static property | `__new__` pattern |

## Architecture

```
library/python/
├── rtms_manager/
│   ├── __init__.py
│   ├── rtms_manager.py      # Main RTMSManager class
│   ├── signaling_socket.py  # Signaling WebSocket handler
│   ├── media_socket.py      # Media WebSocket handler
│   └── utils/
│       ├── config.py        # Configuration classes
│       ├── logger.py        # FileLogger
│       ├── media_params.py  # Media constants
│       └── signature.py     # HMAC signature generation
├── webhook_manager/
│   └── webhook_manager.py   # Flask/FastAPI webhook handler
├── frontend_manager/
│   └── frontend_wss_manager.py  # WebSocket broadcast manager
└── requirements.txt
```
