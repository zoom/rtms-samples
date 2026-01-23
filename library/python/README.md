# RTMSManager - Python

## Installation

```bash
pip install websockets flask  # or fastapi uvicorn
```

## Quick Start (Flask)

```python
import os
import asyncio
from flask import Flask
from library.python.rtms_manager import RTMSManager, MediaType
from library.python.webhook_manager import WebhookManager

app = Flask(__name__)
rtms = None

async def init_rtms():
    global rtms
    rtms = await RTMSManager.init({
        'credentials': {
            'meeting': {
                'client_id': os.environ['ZOOM_CLIENT_ID'],
                'client_secret': os.environ['ZOOM_CLIENT_SECRET'],
                'secret_token': os.environ['ZOOM_SECRET_TOKEN'],
            }
        },
        'media_types': MediaType.AUDIO | MediaType.TRANSCRIPT,
        'logging': 'info'
    })
    
    # Handle media events
    rtms.on('audio', lambda data: print(f"Audio from {data['user_name']}: {len(data['buffer'])} bytes"))
    rtms.on('transcript', lambda data: print(f"{data['user_name']}: {data['text']}"))
    rtms.on('error', lambda err: print(f"Error: {err}"))

# Initialize on startup
asyncio.get_event_loop().run_until_complete(init_rtms())

# Setup webhook with auto-validation
webhook = WebhookManager(
    webhook_path='/webhook',
    zoom_secret_token=os.environ['ZOOM_SECRET_TOKEN']
)
webhook.setup_flask(app, rtms)

if __name__ == '__main__':
    app.run(port=3000)
```

## Quick Start (FastAPI)

```python
import os
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
                'client_id': os.environ['ZOOM_CLIENT_ID'],
                'client_secret': os.environ['ZOOM_CLIENT_SECRET'],
                'secret_token': os.environ['ZOOM_SECRET_TOKEN'],
            }
        },
        'media_types': MediaType.AUDIO | MediaType.TRANSCRIPT,
    })
    
    rtms.on('audio', lambda data: print(f"Audio: {len(data['buffer'])} bytes"))
    rtms.on('transcript', lambda data: print(f"{data['user_name']}: {data['text']}"))
    
    webhook = WebhookManager(
        webhook_path='/webhook',
        zoom_secret_token=os.environ['ZOOM_SECRET_TOKEN']
    )
    webhook.setup_fastapi(app, rtms)

@app.on_event("shutdown")
async def shutdown():
    if rtms:
        await rtms.stop()
```

## Media Types

```python
from library.python.rtms_manager import MediaType

MediaType.AUDIO        # 1
MediaType.VIDEO        # 2
MediaType.SHARESCREEN  # 4
MediaType.TRANSCRIPT   # 8
MediaType.CHAT         # 16
MediaType.ALL          # 32

# Combine with bitwise OR
media_types = MediaType.AUDIO | MediaType.TRANSCRIPT  # 9
```

## Presets

```python
# Audio only (speech processing)
await RTMSManager.init({ **RTMSManager.PRESETS['AUDIO_ONLY'], 'credentials': credentials })

# Audio + transcript (captions)
await RTMSManager.init({ **RTMSManager.PRESETS['TRANSCRIPTION'], 'credentials': credentials })

# Audio + video (recording)
await RTMSManager.init({ **RTMSManager.PRESETS['VIDEO_RECORDING'], 'credentials': credentials })

# All media types
await RTMSManager.init({ **RTMSManager.PRESETS['FULL_MEDIA'], 'credentials': credentials })
```

## Events

```python
# Media events - data dict contains: buffer/text, user_id, user_name, timestamp, meeting_id, stream_id
rtms.on('audio', lambda data: ...)      # data['buffer'] = bytes
rtms.on('video', lambda data: ...)      # data['buffer'] = bytes  
rtms.on('sharescreen', lambda data: ...)
rtms.on('transcript', lambda data: ...) # data['text'] = str
rtms.on('chat', lambda data: ...)       # data['text'] = str

# Lifecycle events
rtms.on('meeting.rtms_started', lambda payload: ...)
rtms.on('meeting.rtms_stopped', lambda payload: ...)
rtms.on('error', lambda error: ...)
```

## Configuration

```python
await RTMSManager.init({
    'credentials': {
        'meeting': { 'client_id', 'client_secret', 'secret_token' },
        'video_sdk': { 'client_id', 'client_secret', 'secret_token' },  # Optional
    },
    'media_types': MediaType.ALL,
    'logging': 'info',            # 'off' | 'error' | 'warn' | 'info' | 'debug'
    'log_dir': '/var/log/rtms',
    'enable_gap_filling': False,  # Insert silence during network drops (for recording)
})
```

## Full Documentation

See [library/README.md](../README.md) for complete documentation including:
- Helper classes (WebhookManager, FrontendWssManager)
- Utilities (FileLogger, RTMSError, signatureHelper)
- Advanced features (reconnection, state management, gap filling)
- Architecture overview
