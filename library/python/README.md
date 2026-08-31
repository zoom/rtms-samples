# RTMSManager - Python

`WebhookManager` authenticates normal Zoom webhook deliveries against the exact raw
request body and rejects missing, stale, or invalid signatures. The default timestamp
tolerance is 300 seconds.

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
# Media events - data dict contains: buffer/text, user_id, user_name, timestamp, rtms_id, meeting_id, stream_id
rtms.on('audio', lambda data: ...)      # data['buffer'] = bytes
rtms.on('video', lambda data: ...)      # data['buffer'] = bytes  
rtms.on('sharescreen', lambda data: ...)
rtms.on('transcript', lambda data: ...) # data['text'] = str
rtms.on('chat', lambda data: ...)       # text plus chat_session/sender/receiver/message metadata
rtms.on('participant_video_on', lambda data: ...)   # data['available_participants']
rtms.on('participant_video_off', lambda data: ...)
rtms.on('video_subscription_response', lambda data: ...)
rtms.on('stream_close_response', lambda data: ...)

# Lifecycle events
rtms.on('meeting.rtms_started', lambda payload: ...)
rtms.on('meeting.rtms_stopped', lambda payload: ...)
rtms.on('contact_center.voice_rtms_started', lambda payload: ...)
rtms.on('contact_center.voice_rtms_stopped', lambda payload: ...)
rtms.on('phone.rtms_started', lambda payload: ...)
rtms.on('phone.rtms_stopped', lambda payload: ...)
rtms.on('error', lambda error: ...)

# Signaling chat-group lifecycle events. The raw event payload is data['data'].
rtms.on('chat_group_created', lambda data: ...)
rtms.on('chat_group_deleted', lambda data: ...)
rtms.on('chat_group_members_added', lambda data: ...)
rtms.on('chat_group_members_removed', lambda data: ...)
rtms.on('chat_group_member_status_updated', lambda data: ...)

Chat metadata is read from the RTMS `content` object and the original message
data is preserved in `raw_data`. Nested JSON payloads are also accepted for
compatibility. Key participant records by `user_id`, not display name, so
simultaneous PSTN clients remain distinct.
```

## Configuration

```python
await RTMSManager.init({
    'credentials': {
        'meeting': { 'client_id': '...', 'client_secret': '...', 'secret_token': '...' },
        'webinar': { 'client_id': '...', 'client_secret': '...', 'secret_token': '...' },  # Optional
        'video_sdk': { 'client_id': '...', 'client_secret': '...', 'secret_token': '...' },  # Optional
        'contact_center': { 'client_id': '...', 'client_secret': '...', 'secret_token': '...' },  # Optional
        'phone': { 'client_id': '...', 'client_secret': '...', 'secret_token': '...' },  # Optional
    },
    'media_types': MediaType.ALL,
    'logging': 'info',            # 'off' | 'error' | 'warn' | 'info' | 'debug'
    'log_dir': '/var/log/rtms',
    'enable_gap_filling': False,  # Insert silence during network drops (for recording)
    'media_params': {
        'transcript': {
            'language': 9,
            'src_language': 9,
            'enable_lid': True,
        },
        'video': {
            'data_opt': RTMSManager.MEDIA_PARAMS['MEDIA_DATA_OPTION_VIDEO_SINGLE_INDIVIDUAL_STREAM'],
        }
    },
    'protocol_definitions': {
        'message_types': {
            'STREAM_CLOSE_REQ': 21,
            'STREAM_CLOSE_RESP': 22,
            'VIDEO_SUBSCRIPTION_REQ': 28,
            'VIDEO_SUBSCRIPTION_RESP': 29,
        },
        'event_types': {
            'PARTICIPANT_VIDEO_ON': 8,
            'PARTICIPANT_VIDEO_OFF': 9,
            'CHAT_GROUP_CREATE': 10,
            'CHAT_GROUP_DELETE': 11,
            'CHAT_GROUP_MEMBERS_ADD': 12,
            'CHAT_GROUP_MEMBERS_DELETE': 13,
            'CHAT_GROUP_MEMBER_STATUS_UPDATE': 14,
        },
        'status_codes': {
            'INVALID_MEDIA_TRANSCRIPT_TARGET_LANGUAGE': 46,
            'CHAT_SESSION_KEY_NOT_AVAILABLE': 47,
        },
        'media_data_options': {
            'VIDEO_SINGLE_INDIVIDUAL_STREAM': 4,
        },
    }
})
```

## Individual Video Subscription

```python
participants = rtms.get_video_on_participants(stream_id)
if participants:
    await rtms.subscribe_to_individual_video(stream_id, participants[0]['user_id'])

# Graceful backend-initiated shutdown
await rtms.request_stream_close(stream_id)
```

## Full Documentation

See [library/README.md](../README.md) for complete documentation including:
- Helper classes (WebhookManager, FrontendWssManager)
- Utilities (FileLogger, RTMSError, signatureHelper)
- Advanced features (reconnection, state management, gap filling)
- Architecture overview
