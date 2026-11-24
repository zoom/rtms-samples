import asyncio
import json
import base64
import time
from typing import Callable, Dict, Any, Optional
import websockets
from websockets.client import WebSocketClientProtocol

from .utils.signature import generate_rtms_signature
from .utils.logger import FileLogger
from .utils.rtms_entity import build_rtms_entity_payload
from .utils.rtms_error import RTMSError, NON_RETRYABLE_CATEGORIES
from .utils.event_lookup import get_rtms_status_code
from .utils.url_policy import is_allowed_rtms_callback_url
from .signaling_socket import send_deferred_event_subscriptions, get_protocol_version


TYPE_FLAGS = {
    'audio': 1,
    'video': 2,
    'sharescreen': 4,
    'transcript': 8,
    'chat': 16,
}

DEFAULT_MEDIA_PARAMS = {
    'audio': {
        'content_type': 2,
        'sample_rate': 1,
        'channel': 1,
        'codec': 1,
        'data_opt': 1,
        'send_rate': 100,
    },
    'video': {
        'content_type': 3,
        'codec': 7,
        'data_opt': 3,
        'resolution': 2,
        'fps': 25,
    },
    'deskshare': {
        'content_type': 3,
        'codec': 5,
        'resolution': 2,
        'fps': 1,
    },
    'chat': {'content_type': 5},
    'transcript': {'content_type': 5},
}


def _parse_chat_payload(raw_data: Any) -> Dict[str, Any]:
    if isinstance(raw_data, dict):
        return raw_data
    if not isinstance(raw_data, str):
        return {'data': raw_data}
    try:
        parsed = json.loads(raw_data)
        return parsed if isinstance(parsed, dict) else {'data': parsed}
    except json.JSONDecodeError:
        # Keep compatibility with older servers that sent plain UTF-8 chat text.
        return {'data': raw_data}


def _build_media_params_for_socket(configured_media_params: Dict[str, Any], media_type: str) -> Dict[str, Any]:
    media_params_key = 'deskshare' if media_type == 'sharescreen' else media_type
    if isinstance(configured_media_params.get(media_params_key), dict):
        return {media_params_key: dict(configured_media_params[media_params_key])}
    return {}


def merge_media_config(
    current_config: Optional[Dict[str, Any]],
    media_params: Optional[Dict[str, Any]],
    media_type: Optional[str] = None,
) -> Dict[str, Any]:
    """Merge per-socket media parameters without clobbering other media types."""
    merged = dict(current_config or {})
    if isinstance(media_params, dict):
        merged.update(media_params)
    return merged


def get_phone_participant_name(conn: Dict[str, Any], channel_id: Any) -> Optional[str]:
    if channel_id is None:
        return None
    call_info = conn.get('phone_call_info')
    if not isinstance(call_info, dict):
        return None
    participants = call_info.get('participants') or []
    target = str(channel_id)
    for participant in participants:
        if isinstance(participant, dict) and str(participant.get('channel_id')) == target:
            return participant.get('name')
    return None


def build_media_handshake_message(
    meeting_uuid: str,
    stream_id: str,
    conn: Dict[str, Any],
    client_id: str,
    client_secret: str,
    media_type: str,
    media_type_flag: int,
) -> Dict[str, Any]:
    rtms_type = conn.get('rtms_type', 'meeting')
    signature = generate_rtms_signature(meeting_uuid, stream_id, client_id, client_secret)
    configured_media_params = conn.get('config', {}).get('media_params') or DEFAULT_MEDIA_PARAMS

    # Zoom Phone media is per-channel and the Phone quickstart sends no
    # meeting-style media_params unless explicitly passed via phone_media_params.
    if rtms_type == 'phone':
        phone_params = conn.get('config', {}).get('phone_media_params') or {}
        media_params = _build_media_params_for_socket(phone_params, media_type)
    else:
        media_params = _build_media_params_for_socket(configured_media_params, media_type)

    if isinstance(media_params.get('transcript'), dict):
        transcript_params = dict(media_params['transcript'])
        language = transcript_params.pop('language', None)
        if transcript_params.get('src_language') is None and language is not None:
            transcript_params['src_language'] = language
        if transcript_params.get('enable_lid') is None and transcript_params.get('src_language') is not None:
            transcript_params['enable_lid'] = True
        media_params = {
            **media_params,
            'transcript': transcript_params,
        }

    protocol_version = get_protocol_version(conn)
    handshake_msg: Dict[str, Any] = {
        'msg_type': 3,
        'protocol_version': protocol_version,
        **build_rtms_entity_payload(rtms_type, meeting_uuid),
        'rtms_stream_id': stream_id,
        'signature': signature,
        'media_type': media_type_flag,
    }
    # V1 carried payload_encryption on the data handshake. V2 negotiates
    # encryption only in the signaling handshake.
    if protocol_version < 2:
        handshake_msg['payload_encryption'] = False
    if media_params:
        handshake_msg['media_params'] = media_params
    return handshake_msg


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

    media_map = conn.setdefault('media', {})
    existing = media_map.get(media_type)
    if isinstance(existing, dict) and existing.get('reconnect_task'):
        existing['reconnect_task'].cancel()
        existing['reconnect_task'] = None

    if not is_allowed_rtms_callback_url(media_url):
        err = RTMSError.from_code(
            'CONNECTION_FAILED',
            message=f'Refusing media URL outside allowlist: {media_url}',
            meeting_id=meeting_uuid,
            stream_id=stream_id,
        )
        FileLogger.error(f"[Media] [{rtms_type},{meeting_uuid},{stream_id}] {err.to_short_string()}")
        emit('error', err)
        return None

    try:
        ws = await websockets.connect(media_url)
    except Exception as e:
        err = RTMSError.from_code(
            'MEDIA_ERROR',
            message=f'{media_type} connection failed: {e}',
            meeting_id=meeting_uuid,
            stream_id=stream_id,
            cause=e,
        )
        FileLogger.error(f"[Media] [{rtms_type},{meeting_uuid},{stream_id}] {err.to_short_string()}")
        emit('error', err)
        return None

    media_obj = {
        'socket': ws,
        'state': 'connecting',
        'url': media_url,
        'media_type_flag': media_type_flag,
        'last_keep_alive': None,
        'reconnect_task': None,
    }
    media_map[media_type] = media_obj

    if not conn.get('should_reconnect', True):
        FileLogger.warn(f"[Media] [{rtms_type},{meeting_uuid},{stream_id}] Aborting open: RTMS stopped")
        await ws.close()
        return None

    FileLogger.log(f"[Media] [{rtms_type},{meeting_uuid},{stream_id}] Generating signature for {media_type} handshake")
    handshake_msg = build_media_handshake_message(
        meeting_uuid, stream_id, conn, client_id, client_secret, media_type, media_type_flag
    )
    FileLogger.log(
        f"[Media] [{rtms_type},{meeting_uuid},{stream_id}] {media_type} handshake summary: "
        f"{json.dumps({'media_type': media_type_flag, 'media_params': handshake_msg.get('media_params', {})})}"
    )

    conn['media_config'] = merge_media_config(conn.get('media_config'), handshake_msg.get('media_params'), media_type)

    await ws.send(json.dumps(handshake_msg))
    media_obj['state'] = 'authenticated'

    asyncio.create_task(_handle_media_messages(
        ws, meeting_uuid, stream_id, conn, client_id, client_secret,
        media_type, media_type_flag, emit
    ))

    return ws


async def handle_media_message(
    raw_message: Any,
    ws: Any,
    meeting_uuid: str,
    stream_id: str,
    conn: Dict[str, Any],
    media_type: str,
    emit: Callable,
):
    rtms_type = conn.get('rtms_type', 'meeting')

    if isinstance(raw_message, dict):
        msg = raw_message
    else:
        try:
            data = raw_message.decode('utf-8') if isinstance(raw_message, bytes) else raw_message
            msg = json.loads(data)
        except (json.JSONDecodeError, UnicodeDecodeError):
            return

    msg_type = msg.get('msg_type')

    if msg_type == 4:
        status = msg.get('status_code', msg.get('status', -1))
        status_text = get_rtms_status_code(status)
        if status == 0:
            FileLogger.log(
                f"[Media] [{rtms_type},{meeting_uuid},{stream_id}] Handshake response ({media_type}): status={status} ({status_text})"
            )
            FileLogger.log(f"[Media] [{rtms_type},{meeting_uuid},{stream_id}] {media_type} handshake OK")
            if media_type and isinstance(conn.get('media', {}).get(media_type), dict):
                conn['media'][media_type]['state'] = 'streaming'
            signaling_ws = conn.get('signaling', {}).get('socket')
            if signaling_ws:
                await signaling_ws.send(json.dumps({
                    'msg_type': 7,
                    'rtms_stream_id': stream_id,
                }))
            if media_type == 'video' and conn.get('pending_event_subscription_payload') and not conn.get('event_subscriptions_sent'):
                await send_deferred_event_subscriptions(conn, meeting_uuid, stream_id)
        else:
            err = RTMSError.from_zoom_status(status, meeting_id=meeting_uuid, stream_id=stream_id)
            FileLogger.error(f"[Media] [{rtms_type},{meeting_uuid},{stream_id}] {media_type} {err.to_short_string()}")
            if err.category in NON_RETRYABLE_CATEGORIES or status in (14, 15, 16):
                conn['should_reconnect'] = False
            emit('error', err)
            if ws and not getattr(ws, 'closed', False):
                try:
                    res = ws.close()
                    if asyncio.iscoroutine(res):
                        await res
                except Exception:
                    pass

    elif msg_type in (5, 14, 15, 16, 17, 18):
        content = msg.get('content', {})
        data_type = content.get('data_type', msg_type if msg_type != 5 else None)
        user_id = content.get('user_id', 'unknown')
        user_name = content.get('user_name', 'Unknown')
        timestamp = content.get('timestamp', 0)
        raw_data = content.get('data', '')

        if timestamp:
            conn['last_packet_timestamp'] = timestamp

        if data_type in (1, 14):
            channel_id = content.get('channel_id')
            resolved_user_id = content.get('user_id') if content.get('user_id') is not None else (channel_id if channel_id is not None else 'unknown')
            resolved_user_name = content.get('user_name')
            if resolved_user_name is None:
                resolved_user_name = get_phone_participant_name(conn, channel_id)
                if resolved_user_name is None and rtms_type != 'phone':
                    resolved_user_name = 'Unknown'
            buffer = base64.b64decode(raw_data) if raw_data else b''
            emit('audio', {
                'buffer': buffer,
                'user_id': resolved_user_id,
                'user_name': resolved_user_name,
                'channel_id': channel_id,
                'source': content.get('source'),
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

        elif msg_type == 18 or data_type == 18:
            parsed_chat_data = _parse_chat_payload(raw_data)
            chat_data = {
                **content,
                **(parsed_chat_data if isinstance(parsed_chat_data, dict) else {}),
            }
            sender = chat_data.get('sender') if isinstance(chat_data.get('sender'), dict) else {}
            receiver = chat_data.get('receiver') if isinstance(chat_data.get('receiver'), dict) else None
            message_text = chat_data.get('data', '')
            resolved_user_id = sender.get('user_id', sender.get('userId', chat_data.get('user_id', chat_data.get('userId', user_id))))
            resolved_user_name = sender.get('user_name', sender.get('userName', chat_data.get('user_name', chat_data.get('userName', user_name))))
            emit('chat', {
                'text': message_text if isinstance(message_text, str) else str(message_text),
                'data': chat_data,
                'raw_data': raw_data,
                'chat_session': chat_data.get('chat_session'),
                'operation_type': chat_data.get('operation_type'),
                'message_id': chat_data.get('message_id'),
                'parent_message_id': chat_data.get('parent_message_id'),
                'sender': sender,
                'receiver': receiver,
                'files': chat_data.get('files', []),
                'delete_file_id_list': chat_data.get('delete_file_id_list', []),
                'user_id': resolved_user_id,
                'user_name': resolved_user_name,
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
            attribute = content.get('attribute')
            channel_id = content.get('channel_id')
            try:
                is_update = int(attribute) == 2
            except (TypeError, ValueError):
                is_update = False
            resolved_user_id = content.get('user_id') if content.get('user_id') is not None else (channel_id if channel_id is not None else 'unknown')
            resolved_user_name = content.get('user_name')
            if resolved_user_name is None:
                resolved_user_name = get_phone_participant_name(conn, channel_id)
                if resolved_user_name is None and rtms_type != 'phone':
                    resolved_user_name = 'Unknown'
            emit('transcript', {
                'text': raw_data,
                'user_id': resolved_user_id,
                'user_name': resolved_user_name,
                'timestamp': timestamp,
                'start_time': content.get('start_time'),
                'end_time': content.get('end_time'),
                'language': content.get('language'),
                # Transcript rewind: a revision has attribute 2 and the same
                # sentence_id (per channel_id on Phone); 0 is a valid sentence ID.
                'channel_id': channel_id,
                'sentence_id': content.get('sentence_id'),
                'attribute': attribute,
                'is_update': is_update,
                'rtms_id': meeting_uuid,
                'meeting_id': meeting_uuid,
                'stream_id': stream_id,
                'product_type': rtms_type,
            })

    elif msg_type == 6:
        FileLogger.log(f"[Media] [{rtms_type},{meeting_uuid},{stream_id}] Event: {msg}")
        emit('event', msg.get('content', {}), meeting_uuid, stream_id, rtms_type)

    elif msg_type == 12:
        if media_type and isinstance(conn.get('media', {}).get(media_type), dict):
            conn['media'][media_type]['last_keep_alive'] = int(time.time() * 1000)
        pong_msg = {'msg_type': 13}
        if 'timestamp' in msg:
            pong_msg['timestamp'] = msg['timestamp']
        await ws.send(json.dumps(pong_msg))


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
            media_obj = conn.get('media', {}).get(media_type)
            if isinstance(media_obj, dict) and media_obj.get('socket') is not None and media_obj.get('socket') is not ws:
                continue
            await handle_media_message(message, ws, meeting_uuid, stream_id, conn, media_type, emit)

    except websockets.exceptions.ConnectionClosed as e:
        FileLogger.warn(f"[Media] [{rtms_type},{meeting_uuid},{stream_id}] {media_type} socket closed (code: {e.code})")
        media_obj = conn.get('media', {}).get(media_type)
        if not isinstance(media_obj, dict) or media_obj.get('socket') is not ws:
            FileLogger.log(f"[Media] [{rtms_type},{meeting_uuid},{stream_id}] Ignoring stale {media_type} socket close")
            return
        media_obj['state'] = 'closed'

        if not conn.get('should_reconnect', False):
            FileLogger.log(f"[Media] [{rtms_type},{meeting_uuid},{stream_id}] Not reconnecting — RTMS was stopped.")
            return

        signaling = conn.get('signaling', {})
        signaling_ws = signaling.get('socket')
        signaling_ready = signaling.get('state') == 'ready' and signaling_ws and not getattr(signaling_ws, 'closed', False)
        if signaling_ready:
            delay_sec = (conn.get('config', {}).get('reconnect_delay') or 3000) / 1000.0
            FileLogger.log(f"[Media] [{rtms_type},{meeting_uuid},{stream_id}] Reconnecting {media_type} in {delay_sec:.1f}s...")

            async def _reconnect_media():
                await asyncio.sleep(delay_sec)
                media_obj['reconnect_task'] = None
                sig = conn.get('signaling', {})
                sig_ws = sig.get('socket')
                if not conn.get('should_reconnect', False) or sig.get('state') != 'ready' or not sig_ws or getattr(sig_ws, 'closed', False):
                    return
                await connect_to_media_websocket(
                    media_obj['url'],
                    meeting_uuid, stream_id, conn,
                    client_id, client_secret,
                    media_type, media_type_flag, emit
                )

            media_obj['reconnect_task'] = asyncio.create_task(_reconnect_media())
        else:
            FileLogger.warn(f"[Media] [{rtms_type},{meeting_uuid},{stream_id}] Signaling not ready. Restarting both sockets...")
            reconnect_signaling = conn.get('_reconnect_signaling')
            if callable(reconnect_signaling):
                res = reconnect_signaling()
                if asyncio.iscoroutine(res):
                    await res

    except Exception as e:
        FileLogger.error(f"[Media] [{rtms_type},{meeting_uuid},{stream_id}] {media_type} error: {e}")
        if isinstance(conn.get('media', {}).get(media_type), dict):
            conn['media'][media_type]['state'] = 'error'
