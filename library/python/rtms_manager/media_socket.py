import asyncio
import json
import base64
from typing import Callable, Dict, Any, Optional
import websockets
from websockets.client import WebSocketClientProtocol

from .utils.signature import generate_rtms_signature
from .utils.logger import FileLogger
from .utils.rtms_entity import build_rtms_entity_payload, normalize_rtms_type


TYPE_FLAGS = {
    'audio': 1,
    'video': 2,
    'sharescreen': 4,
    'transcript': 8,
    'chat': 16,
    'all': 32,
}


async def connect_to_media_websocket(
    media_url: str,
    meeting_uuid: str,
    stream_id: str,
    conn: Dict[str, Any],
    client_id: str,
    client_secret: str,
    media_type: str,
    media_type_flag: int,
    emit: Callable
) -> Optional[WebSocketClientProtocol]:
    rtms_type = conn.get('rtms_type', 'meeting')
    FileLogger.log(f"[Media] [{rtms_type},{meeting_uuid},{stream_id}] Connecting {media_type} socket to {media_url}...")

    try:
        ws = await websockets.connect(media_url)
    except Exception as e:
        FileLogger.error(f"[Media] [{rtms_type},{meeting_uuid},{stream_id}] {media_type} connection failed: {e}")
        return None

    if 'media' not in conn:
        conn['media'] = {}

    conn['media'][media_type] = {
        'socket': ws,
        'state': 'connecting',
        'url': media_url,
        'media_type_flag': media_type_flag,
    }

    if not conn.get('should_reconnect', True):
        FileLogger.warn(f"[Media] [{rtms_type},{meeting_uuid},{stream_id}] Aborting open: RTMS stopped")
        await ws.close()
        return None

    FileLogger.log(f"[Media] [{rtms_type},{meeting_uuid},{stream_id}] Generating signature for {media_type} handshake")

    signature = generate_rtms_signature(meeting_uuid, stream_id, client_id, client_secret)

    media_params = conn.get('config', {}).get('media_params', {
        'audio': {
            'content_type': 2,
            'sample_rate': 1,
            'channel': 1,
            'codec': 1,
            'data_opt': 1,
            'send_rate': 100
        },
        'video': {
            'content_type': 3,
            'codec': 7,
            'data_opt': 3,
            'resolution': 2,
            'fps': 25
        },
        'deskshare': {
            'content_type': 3,
            'codec': 5,
            'resolution': 2,
            'fps': 1
        },
        'chat': {'content_type': 5},
        'transcript': {'content_type': 5}
    })

    if normalize_rtms_type(rtms_type) == 'contact_center' and isinstance(media_params.get('transcript'), dict):
        transcript_params = dict(media_params['transcript'])
        language = transcript_params.pop('language', None)
        if transcript_params.get('src_language') is None and language is not None:
            transcript_params['src_language'] = language
        if transcript_params.get('enable_lid') is None:
            transcript_params['enable_lid'] = True
        media_params = {
            **media_params,
            'transcript': transcript_params,
        }

    handshake_msg = {
        'msg_type': 3,
        'protocol_version': 1,
        **build_rtms_entity_payload(rtms_type, meeting_uuid),
        'rtms_stream_id': stream_id,
        'signature': signature,
        'media_type': media_type_flag,
        'payload_encryption': False,
        'media_params': media_params
    }

    FileLogger.log(f"[Media] [{rtms_type},{meeting_uuid},{stream_id}] {media_type} handshake payload: {json.dumps(handshake_msg)}")

    conn['media_config'] = media_params

    await ws.send(json.dumps(handshake_msg))
    conn['media'][media_type]['state'] = 'authenticated'

    asyncio.create_task(_handle_media_messages(
        ws, meeting_uuid, stream_id, conn, client_id, client_secret,
        media_type, media_type_flag, emit
    ))

    return ws


async def _handle_media_messages(
    ws: WebSocketClientProtocol,
    meeting_uuid: str,
    stream_id: str,
    conn: Dict[str, Any],
    client_id: str,
    client_secret: str,
    media_type: str,
    media_type_flag: int,
    emit: Callable
):
    rtms_type = conn.get('rtms_type', 'meeting')

    try:
        async for message in ws:
            try:
                if isinstance(message, bytes):
                    data = message.decode('utf-8')
                else:
                    data = message
                msg = json.loads(data)
            except (json.JSONDecodeError, UnicodeDecodeError):
                continue

            msg_type = msg.get('msg_type')

            if msg_type == 4:
                status = msg.get('status_code', msg.get('status', -1))
                if status == 0:
                    FileLogger.log(f"[Media] [{rtms_type},{meeting_uuid},{stream_id}] {media_type} handshake OK")
                    conn['media'][media_type]['state'] = 'ready'
                else:
                    FileLogger.error(f"[Media] [{rtms_type},{meeting_uuid},{stream_id}] {media_type} handshake failed: {status}")

            elif msg_type in (5, 14, 15, 16, 17, 18):
                content = msg.get('content', {})
                data_type = content.get('data_type', msg_type if msg_type != 5 else None)
                user_id = content.get('user_id', 'unknown')
                user_name = content.get('user_name', 'Unknown')
                timestamp = content.get('timestamp', 0)
                raw_data = content.get('data', '')

                if data_type in (1, 14):
                    buffer = base64.b64decode(raw_data) if raw_data else b''
                    emit('audio', {
                        'buffer': buffer,
                        'user_id': user_id,
                        'user_name': user_name,
                        'timestamp': timestamp,
                        'rtms_id': meeting_uuid,
                        'meeting_id': meeting_uuid,
                        'stream_id': stream_id,
                        'product_type': rtms_type,
                    })

                elif data_type in (2, 15):
                    buffer = base64.b64decode(raw_data) if raw_data else b''
                    emit('video', {
                        'buffer': buffer,
                        'user_id': user_id,
                        'user_name': user_name,
                        'timestamp': timestamp,
                        'rtms_id': meeting_uuid,
                        'meeting_id': meeting_uuid,
                        'stream_id': stream_id,
                        'product_type': rtms_type,
                    })

                elif data_type in (4, 16):
                    buffer = base64.b64decode(raw_data) if raw_data else b''
                    emit('sharescreen', {
                        'buffer': buffer,
                        'user_id': user_id,
                        'user_name': user_name,
                        'timestamp': timestamp,
                        'rtms_id': meeting_uuid,
                        'meeting_id': meeting_uuid,
                        'stream_id': stream_id,
                        'product_type': rtms_type,
                    })

                elif data_type in (8, 17):
                    emit('transcript', {
                        'text': raw_data,
                        'user_id': user_id,
                        'user_name': user_name,
                        'timestamp': timestamp,
                        'rtms_id': meeting_uuid,
                        'meeting_id': meeting_uuid,
                        'stream_id': stream_id,
                        'product_type': rtms_type,
                    })

                elif data_type in (16, 18):
                    emit('chat', {
                        'text': raw_data,
                        'user_id': user_id,
                        'user_name': user_name,
                        'timestamp': timestamp,
                        'rtms_id': meeting_uuid,
                        'meeting_id': meeting_uuid,
                        'stream_id': stream_id,
                        'product_type': rtms_type,
                    })

            elif msg_type == 6:
                FileLogger.log(f"[Media] [{rtms_type},{meeting_uuid},{stream_id}] Event: {msg}")
                emit('event', msg.get('content', {}), meeting_uuid, stream_id, rtms_type)

            elif msg_type == 12:
                pong_msg = {'msg_type': 13}
                if 'timestamp' in msg:
                    pong_msg['timestamp'] = msg['timestamp']
                await ws.send(json.dumps(pong_msg))

    except websockets.exceptions.ConnectionClosed as e:
        FileLogger.warn(f"[Media] [{rtms_type},{meeting_uuid},{stream_id}] {media_type} socket closed (code: {e.code})")
        conn['media'][media_type]['state'] = 'closed'

        if not conn.get('should_reconnect', False):
            FileLogger.log(f"[Media] [{rtms_type},{meeting_uuid},{stream_id}] Not reconnecting — RTMS was stopped.")
            return

        signaling_state = conn.get('signaling', {}).get('state')
        if signaling_state == 'ready':
            FileLogger.log(f"[Media] [{rtms_type},{meeting_uuid},{stream_id}] Reconnecting {media_type} in 3s...")
            await asyncio.sleep(3)
            await connect_to_media_websocket(
                conn['media'][media_type]['url'],
                meeting_uuid, stream_id, conn,
                client_id, client_secret,
                media_type, media_type_flag, emit
            )

    except Exception as e:
        FileLogger.error(f"[Media] [{rtms_type},{meeting_uuid},{stream_id}] {media_type} error: {e}")
        conn['media'][media_type]['state'] = 'error'
