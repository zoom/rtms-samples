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

# Combine with bitwise OR
media_types = MediaType.AUDIO | MediaType.TRANSCRIPT  # 9
```

Each selected flag opens a separate data connection. Unified media socket mode
and `media_type: 32` are deprecated; send exactly one concrete media type in
each data handshake.

## RTMS Protocol V2

The library uses RTMS protocol V2 by default:

- Both the signaling and data handshakes send `protocol_version: 2`. Pass
  `protocol_version=1` (or `protocolVersion`) in the init options to fall back
  to V1. Zoom Phone always uses V2.
- Each media type has its own data connection. V2 rejects `media_type: 32`
  (ALL) with status `48`.
- Event subscriptions are sent with `event_code` (session events `1000` to
  `1011`). `'event'` payloads carry `eventCode` (V2) and the equivalent legacy
  `eventType`; for example participant join is `eventCode` `1001`.
- Comma-separated `server_urls` values (`wss://...,srt://...`) resolve to the
  `wss://` entry, and a single `media_server.server_urls` string serves every
  media type.
- `media_connection_interrupted`, `video_subscription_terminated` and
  `media_data_user_info` are emitted for the V2 automatic events, and rejected
  requests (`REQUEST_ERROR_RESP`, `msg_type 30`) are emitted on `'error'`.

## Presets

```python
# Audio only (speech processing)
await RTMSManager.init({ **RTMSManager.PRESETS['AUDIO_ONLY'], 'credentials': credentials })

# Audio + transcript (captions)
await RTMSManager.init({ **RTMSManager.PRESETS['TRANSCRIPTION'], 'credentials': credentials })

# Audio + video (recording)
await RTMSManager.init({ **RTMSManager.PRESETS['VIDEO_RECORDING'], 'credentials': credentials })

# Zoom Phone (per-channel audio + transcript over V2)
await RTMSManager.init({ **RTMSManager.PRESETS['PHONE'], 'credentials': credentials })
```

## Events

```python
# Media events - data dict contains: buffer/text, user_id, user_name, timestamp, rtms_id, meeting_id, stream_id
rtms.on('audio', lambda data: ...)      # data['buffer'] = bytes; Phone also sets channel_id and source
rtms.on('video', lambda data: ...)      # data['buffer'] = bytes
rtms.on('sharescreen', lambda data: ...)
rtms.on('transcript', lambda data: ...) # data['text'] = str; plus start_time, end_time, language,
                                        # sentence_id, is_update, attribute, channel_id (see Transcript rewind)
rtms.on('chat', lambda data: ...)       # text plus chat_session/sender/receiver/message metadata
rtms.on('participant_video_on', lambda data: ...)   # data['available_participants']
rtms.on('participant_video_off', lambda data: ...)
rtms.on('video_subscription_response', lambda data: ...)
rtms.on('stream_close_response', lambda data: ...)
rtms.on('signaling_ping_rtt', lambda data: ...)     # data['rttMs'], data['signalingHost']

# V2 automatic events
rtms.on('media_connection_interrupted', lambda data: ...)
rtms.on('video_subscription_terminated', lambda data: ...)
rtms.on('media_data_user_info', lambda data: ...)

# Zoom Phone call events (delivered automatically without subscription)
rtms.on('phone_call_info_updated', lambda data: ...)      # data['host_channel_id'], data['participants']
rtms.on('phone_call_hold', lambda data: ...)
rtms.on('phone_call_resume', lambda data: ...)
rtms.on('phone_call_transfer_completed', lambda data: ...) # data['transfer_type'], data['transfer_result']

# Lifecycle events (start / stop / interrupted across all products)
rtms.on('meeting.rtms_started', lambda payload: ...)
rtms.on('meeting.rtms_stopped', lambda payload: ...)
rtms.on('meeting.rtms_interrupted', lambda payload: ...)
rtms.on('webinar.rtms_started', lambda payload: ...)
rtms.on('webinar.rtms_stopped', lambda payload: ...)
rtms.on('webinar.rtms_interrupted', lambda payload: ...)
rtms.on('session.rtms_started', lambda payload: ...)
rtms.on('session.rtms_stopped', lambda payload: ...)
rtms.on('session.rtms_interrupted', lambda payload: ...)
rtms.on('contact_center.voice_rtms_started', lambda payload: ...)
rtms.on('contact_center.voice_rtms_stopped', lambda payload: ...)
rtms.on('contact_center.voice_rtms_interrupted', lambda payload: ...)
rtms.on('phone.call_rtms_started', lambda payload: ...)   # phone.rtms_* aliases also supported
rtms.on('phone.call_rtms_stopped', lambda payload: ...)
rtms.on('phone.call_rtms_interrupted', lambda payload: ...)
rtms.on('error', lambda error: ...)     # receives RTMSError instances

# Signaling chat-group lifecycle events. The raw event payload is data['data'].
rtms.on('chat_group_created', lambda data: ...)
rtms.on('chat_group_deleted', lambda data: ...)
rtms.on('chat_group_members_added', lambda data: ...)
rtms.on('chat_group_members_removed', lambda data: ...)
rtms.on('chat_group_member_status_updated', lambda data: ...)
```

Chat metadata is read from the RTMS `content` object and the original message
data is preserved in `raw_data`. Nested JSON payloads are also accepted for
compatibility. Key participant records by `user_id`, not display name, so
simultaneous PSTN clients remain distinct.

## Stream Metadata, Security, and Utilities

- **Callback URL allowlist**: Signaling and media WebSocket URLs are validated
  against `zoom.us` (`ws://` or `wss://`). Override allowed host suffixes with
  the `RTMS_ALLOWED_MEDIA_HOSTS` environment variable (comma-separated).
- **Errors and lookups**: Import `RTMSError`, `RTMS_EVENT_CODES` (also on
  `RTMSManager.EVENT_CODES`), `redact_secrets`, `get_rtms_session_state`,
  `get_rtms_stream_state`, `get_rtms_stop_reason`, and `get_rtms_status_code`
  from `library.python.rtms_manager`.
- **Frontend & Webhook managers**:
  - `WebhookManager` (with `normalize_webhook_plain_token`, `build_url_validation_response`, `verify_zoom_webhook_request`) validates `endpoint.url_validation` tokens, enforces raw-body HMAC signatures and timestamp tolerances (`WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS`, default `300`), and defers FastAPI event handling via `BackgroundTasks` so Zoom receives an immediate `200`.
  - `FrontendWssManager` fails closed on client registration unless `authorize_registration` is supplied, uses the canonical identity returned by the authorizer, excludes unregistered clients from broadcasts, and enforces `max_payload_bytes` (default 64 KiB).
  - `FrontendManager` serves static frontend assets and resolves `ws://`/`wss://` URLs for Flask or FastAPI.
- **Stream inspection**: Query active or archived streams with
  `RTMSManager.get_stream_metadata(stream_id)`, `get_stream_timestamps(stream_id)`,
  `get_stream_start_time(stream_id)`, `get_stream_media_config(stream_id)`,
  `get_audio_details(stream_id)`, `get_video_details(stream_id)`,
  `get_sharescreen_details(stream_id)`, `get_transcript_details(stream_id)`,
  `get_chat_details(stream_id)`, `get_ping_rtt(stream_id)`, and
  `rtms.get_phone_call_info(stream_id)`. Call `await rtms.reconnect_stream(stream_id)`
  to manually trigger failover reconnection.

## Transcript rewind

RTMS can send a transcript sentence and later a corrected version of it. The
correction reuses the same `sentence_id`, sets `is_update: True` (`attribute: 2`),
and carries the full replacement text. Replace the earlier sentence instead of
appending a new line. `sentence_id` is `None` when the server does not send one,
and `0` is a valid ID.

`TranscriptRevisionStore` does the bookkeeping. It keys sentences by
`(stream_id, channel_id or user_id, sentence_id)`, because Phone sentence IDs
repeat across channels.

```python
from library.python.rtms_manager import TranscriptRevisionStore

transcript = TranscriptRevisionStore()

def on_transcript(event):
    result = transcript.apply(event)
    # result['action']: 'new' | 'updated' | 'recovered' | 'replaced'
    # 'updated' and 'recovered' mean redraw or re-analyze result['sentence'], not append it.

rtms.on('transcript', on_transcript)
rtms.on('meeting.rtms_stopped', lambda payload: transcript.clear(payload.get('rtms_stream_id')))

transcript.sentences(stream_id)  # latest text of every sentence, in start-time order
```

Run the library tests with `python3 -m unittest discover -s tests` from
`library/python`.

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
    'media_types': MediaType.AUDIO | MediaType.TRANSCRIPT,
    'logging': 'off',             # 'off' | 'error' | 'warn' | 'info' | 'debug' | dict
    'log_dir': '/var/log/rtms',
    'enable_gap_filling': False,  # Insert silence during network drops (for recording)
    'max_stream_history_size': 100,
    'signaling_ping_timeout_ms': 5000,
    'subscribe_all_known_events': False,
    'phone_media_params': {},     # Optional override; Phone omits media_params by default
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

See [library/readme.md](../readme.md) for complete documentation including:
- Helper classes (WebhookManager, FrontendWssManager)
- Utilities (FileLogger, RTMSError, signatureHelper)
- Advanced features (reconnection, state management, gap filling)
- Architecture overview
