import asyncio
import json
import random
from typing import Callable, Dict, Any, Optional
import websockets
from websockets.client import WebSocketClientProtocol

from .utils.signature import generate_rtms_signature
from .utils.logger import FileLogger
from .utils.rtms_entity import build_rtms_entity_payload, get_preferred_media_url
from .utils.protocol_definitions import merge_protocol_definitions


STATUS_TEXT = {
    0: 'SUCCESS',
    1: 'INVALID_MESSAGE_TYPE',
    2: 'INVALID_RTMS_STREAM_ID',
    3: 'INVALID_SIGNATURE',
    4: 'INVALID_PAYLOAD',
    5: 'INVALID_EVENTS',
    6: 'INVALID_EVENT_TYPE',
    7: 'INVALID_MEDIA_TYPE',
    8: 'DUPLICATE_SIGNAL_REQUEST',
    40: 'INVALID_RTMS_SESSION_ID',
    41: 'INVALID_CLIENT_READY_ACK',
    42: 'INVALID_EVENT_SUBSCRIBE',
}

MAX_DUPLICATE_SIGNAL_RETRIES = 3
INITIAL_DUPLICATE_SIGNAL_RETRY_DELAY_SECONDS = 1.5


def _get_protocol(conn: Dict[str, Any]):
    return merge_protocol_definitions(conn.get('config', {}).get('protocol_definitions', {}))


def _cancel_task(conn: Dict[str, Any], key: str):
    task = conn.get(key)
    if task:
        task.cancel()
        conn.pop(key, None)


def _release_signaling_connect_lock(conn: Dict[str, Any], ws: Optional[WebSocketClientProtocol]):
    if conn.get('_signaling_connect_ws') is ws:
        conn['_signaling_connect_locked'] = False
        conn['_signaling_connect_ws'] = None


async def _close_socket_quietly(ws: Optional[WebSocketClientProtocol]):
    if not ws:
        return
    if not ws.closed:
        try:
            await ws.close()
        except Exception:
            pass


def _is_individual_video_enabled(conn: Dict[str, Any], media_types_flag: int) -> bool:
    protocol = _get_protocol(conn)
    requested_video = media_types_flag == 32 or bool(media_types_flag & 2)
    video_data_opt = conn.get('config', {}).get('media_params', {}).get('video', {}).get('data_opt')
    return requested_video and video_data_opt == protocol.media_data_options.VIDEO_SINGLE_INDIVIDUAL_STREAM


def _build_event_subscription_payload(conn: Dict[str, Any], media_types_flag: int) -> Dict[str, Any]:
    protocol = _get_protocol(conn)
    events = [
        {'event_type': 2, 'subscribe': True},
        {'event_type': 3, 'subscribe': True},
        {'event_type': 4, 'subscribe': True},
    ]
    if _is_individual_video_enabled(conn, media_types_flag):
        events.extend([
            {'event_type': 5, 'subscribe': True},
            {'event_type': 6, 'subscribe': True},
            {'event_type': protocol.event_types.PARTICIPANT_VIDEO_ON, 'subscribe': True},
            {'event_type': protocol.event_types.PARTICIPANT_VIDEO_OFF, 'subscribe': True},
        ])
    return {'msg_type': 5, 'events': events}


async def send_deferred_event_subscriptions(
    conn: Dict[str, Any],
    meeting_uuid: str,
    stream_id: str,
):
    if not conn.get('pending_event_subscription_payload') or conn.get('event_subscriptions_sent'):
        return

    ws = conn.get('signaling', {}).get('socket')
    if not ws:
        return

    rtms_type = conn.get('rtms_type', 'meeting')
    FileLogger.log(f"[Signaling] [{rtms_type},{meeting_uuid},{stream_id}] Subscribing to events")
    await ws.send(json.dumps(conn['pending_event_subscription_payload']))
    conn['event_subscriptions_sent'] = True


def _extract_participants(event: Dict[str, Any]) -> list[Dict[str, Any]]:
    if isinstance(event.get('participants'), list) and event['participants']:
        return [
            {
                'user_id': participant.get('user_id'),
                'user_name': participant.get('user_name'),
            }
            for participant in event['participants']
            if participant.get('user_id') is not None
        ]

    if event.get('user_id') is None:
        return []

    return [{
        'user_id': event.get('user_id'),
        'user_name': event.get('user_name'),
    }]


def _upsert_video_participants(conn: Dict[str, Any], participants: list[Dict[str, Any]]):
    participant_map = conn.setdefault('video_on_participants', {})
    for participant in participants:
        key = str(participant['user_id'])
        existing = participant_map.get(key, {})
        participant_map[key] = {
            'user_id': participant['user_id'],
            'user_name': participant.get('user_name') or existing.get('user_name'),
        }


def _remove_video_participants(conn: Dict[str, Any], participants: list[Dict[str, Any]]):
    participant_map = conn.setdefault('video_on_participants', {})
    removed = []
    for participant in participants:
        key = str(participant['user_id'])
        if key not in participant_map:
            continue
        removed.append(participant)
        participant_map.pop(key, None)
        if conn.get('current_video_subscription_user_id') is not None and str(conn['current_video_subscription_user_id']) == key:
            conn['current_video_subscription_user_id'] = None
    return removed


def _video_participant_snapshot(conn: Dict[str, Any]) -> list[Dict[str, Any]]:
    return [participant.copy() for participant in conn.get('video_on_participants', {}).values()]


async def connect_to_signaling_websocket(
    meeting_uuid: str,
    stream_id: str,
    server_url: str,
    conn: Dict[str, Any],
    client_id: str,
    client_secret: str,
    emit: Callable,
    media_types_flag: int = 32,
    on_media_url_received: Optional[Callable] = None
) -> Optional[WebSocketClientProtocol]:
    rtms_type = conn.get('rtms_type', 'meeting')
    FileLogger.log(f"[Signaling] [{rtms_type},{meeting_uuid},{stream_id}] Connecting...")

    conn['meeting_uuid'] = meeting_uuid
    conn['stream_id'] = stream_id
    conn['server_url'] = server_url
    if 'media_types_flag' not in conn:
        conn['media_types_flag'] = media_types_flag

    if not server_url or not server_url.startswith('ws'):
        FileLogger.error(f"[Signaling] [{rtms_type},{meeting_uuid},{stream_id}] Invalid server URL: {server_url}")
        emit('error', {'message': 'Invalid server URL', 'meeting_id': meeting_uuid, 'rtms_id': meeting_uuid, 'stream_id': stream_id})
        conn['should_reconnect'] = False
        return None

    if conn.get('_signaling_connect_locked'):
        FileLogger.warn(f"[Signaling] [{rtms_type},{meeting_uuid},{stream_id}] Duplicate connect attempt blocked (connect already in progress).")
        return None

    existing_socket = conn.get('signaling', {}).get('socket')
    if existing_socket and not existing_socket.closed:
        FileLogger.warn(f"[Signaling] [{rtms_type},{meeting_uuid},{stream_id}] Duplicate connect attempt blocked (existing signaling socket still active).")
        return None

    _cancel_task(conn, '_signaling_reconnect_task')
    _cancel_task(conn, '_duplicate_signal_retry_task')
    conn['_signaling_connect_locked'] = True

    try:
        ws = await websockets.connect(server_url)
    except Exception as e:
        conn['_signaling_connect_locked'] = False
        conn['_signaling_connect_ws'] = None
        FileLogger.error(f"[Signaling] [{rtms_type},{meeting_uuid},{stream_id}] Connection failed: {e}")
        emit('error', {'message': str(e), 'meeting_id': meeting_uuid, 'rtms_id': meeting_uuid, 'stream_id': stream_id})
        return None

    conn['_signaling_connect_ws'] = ws
    conn['signaling'] = {'socket': ws, 'state': 'connecting'}

    FileLogger.log(f"[Signaling] [{rtms_type},{meeting_uuid},{stream_id}] Connected, sending handshake")

    if not conn.get('should_reconnect', True):
        FileLogger.warn(f"[Signaling] [{rtms_type},{meeting_uuid},{stream_id}] Aborting - RTMS stopped")
        await _close_socket_quietly(ws)
        _release_signaling_connect_lock(conn, ws)
        return None

    signature = generate_rtms_signature(meeting_uuid, stream_id, client_id, client_secret)

    handshake_msg = {
        'msg_type': 1,
        'protocol_version': 1,
        **build_rtms_entity_payload(rtms_type, meeting_uuid),
        'rtms_stream_id': stream_id,
        'sequence': random.randint(0, 10**9),
        'signature': signature,
        'buffer_data': False,
    }

    await ws.send(json.dumps(handshake_msg))
    conn['signaling']['state'] = 'authenticated'

    asyncio.create_task(_handle_signaling_messages(
        ws, meeting_uuid, stream_id, conn, client_id, client_secret,
        emit, media_types_flag, on_media_url_received
    ))

    return ws


async def _handle_signaling_messages(
    ws: WebSocketClientProtocol,
    meeting_uuid: str,
    stream_id: str,
    conn: Dict[str, Any],
    client_id: str,
    client_secret: str,
    emit: Callable,
    media_types_flag: int,
    on_media_url_received: Optional[Callable]
):
    rtms_type = conn.get('rtms_type', 'meeting')
    
    try:
        async for message in ws:
            if conn.get('signaling', {}).get('socket') is not ws:
                FileLogger.warn(f"[Signaling] [{rtms_type},{meeting_uuid},{stream_id}] Ignoring message from stale signaling socket.")
                continue

            try:
                data = message if isinstance(message, str) else message.decode('utf-8')
                msg = json.loads(data)
            except (json.JSONDecodeError, UnicodeDecodeError):
                continue

            msg_type = msg.get('msg_type')

            if msg_type == 2:
                status = msg.get('status_code', msg.get('status'))
                status_text = STATUS_TEXT.get(status, f'STATUS_{status}')
                is_duplicate_signal_request = 'duplicate signal request' in str(msg.get('reason', '')).lower()
                _release_signaling_connect_lock(conn, ws)
                if status == 0:
                    media_server = msg.get('media_server', {})
                    media_url = get_preferred_media_url(rtms_type, media_server.get('server_urls', {}))
                    country_code = media_server.get('datacenter_region', 'unknown')
                    
                    FileLogger.log(
                        f"[Signaling] [{rtms_type},{meeting_uuid},{stream_id}] Handshake response: status={status} ({status_text})"
                    )
                    FileLogger.log(f"[Signaling] [{rtms_type},{meeting_uuid},{stream_id}] Handshake OK. Media URL: {media_url} (Server: {country_code.upper()})")
                    conn['signaling']['state'] = 'ready'
                    conn['media_server'] = media_server
                    conn['has_connected_signaling'] = True
                    conn['signaling_status8_failures'] = 0
                    conn['_duplicate_signal_retry_count'] = 0
                    _cancel_task(conn, '_duplicate_signal_retry_task')

                    if on_media_url_received:
                        await on_media_url_received(media_url, media_server)

                    conn['pending_event_subscription_payload'] = _build_event_subscription_payload(conn, media_types_flag)
                    conn['event_subscriptions_sent'] = False
                    if _is_individual_video_enabled(conn, media_types_flag):
                        FileLogger.log(
                            f"[Signaling] [{rtms_type},{meeting_uuid},{stream_id}] Deferring event subscription until individual video stream is active"
                        )
                    else:
                        await send_deferred_event_subscriptions(conn, meeting_uuid, stream_id)
                else:
                    if is_duplicate_signal_request and conn.get('should_reconnect', False):
                        retry_count = conn.get('_duplicate_signal_retry_count', 0)
                        if retry_count < MAX_DUPLICATE_SIGNAL_RETRIES:
                            delay = INITIAL_DUPLICATE_SIGNAL_RETRY_DELAY_SECONDS * (2 ** retry_count)
                            conn['_duplicate_signal_retry_count'] = retry_count + 1
                            conn['_suppress_next_signaling_close_reconnect'] = ws
                            _cancel_task(conn, '_duplicate_signal_retry_task')

                            async def _retry_duplicate():
                                await asyncio.sleep(delay)
                                conn.pop('_duplicate_signal_retry_task', None)
                                if conn.get('should_reconnect', False):
                                    await connect_to_signaling_websocket(
                                        conn['meeting_uuid'], stream_id, conn['server_url'], conn,
                                        client_id, client_secret, emit, conn['media_types_flag'],
                                        on_media_url_received
                                    )

                            conn['_duplicate_signal_retry_task'] = asyncio.create_task(_retry_duplicate())
                            FileLogger.warn(
                                f"[Signaling] [{rtms_type},{meeting_uuid},{stream_id}] Duplicate signal request (status={status}), retrying in {delay:.1f}s"
                            )
                            await _close_socket_quietly(ws)
                            continue

                        FileLogger.error(
                            f"[Signaling] [{rtms_type},{meeting_uuid},{stream_id}] Duplicate signal retries exhausted (status={status})"
                        )

                    FileLogger.error(
                        f"[Signaling] [{rtms_type},{meeting_uuid},{stream_id}] Handshake failed: status={status} ({status_text})"
                    )

                    if status == 8 and not conn.get('has_connected_signaling'):
                        failures = conn.get('signaling_status8_failures', 0) + 1
                        conn['signaling_status8_failures'] = failures
                        if failures < 3:
                            FileLogger.warn(
                                f"[Signaling] [{rtms_type},{meeting_uuid},{stream_id}] Initial signaling handshake rejected with status 8; treating as transient startup rejection and waiting for reconnect (attempt {failures})."
                            )
                            continue

                    if status in (14, 15, 16):
                        conn['should_reconnect'] = False

                    emit(
                        'error',
                        {
                            'message': f'Handshake failed: status={status} ({status_text})',
                            'status_code': status,
                            'meeting_id': meeting_uuid,
                            'rtms_id': meeting_uuid,
                            'stream_id': stream_id,
                        },
                    )

            elif msg_type == 12:
                pong_msg = {'msg_type': 13}
                if 'timestamp' in msg:
                    pong_msg['timestamp'] = msg['timestamp']
                await ws.send(json.dumps(pong_msg))

            elif msg_type == 6:
                event = msg.get('event', {})
                event_type = event.get('event_type')
                protocol = _get_protocol(conn)

                if event_type == 4:
                    removed = _remove_video_participants(conn, _extract_participants(event))
                    if removed:
                        emit('video_on_participants_changed', {
                            'type': 'video_on_participants_changed',
                            'participants': removed,
                            'available_participants': _video_participant_snapshot(conn),
                            'data': event,
                            'rtmsId': meeting_uuid,
                            'meetingId': meeting_uuid,
                            'streamId': stream_id,
                            'productType': rtms_type,
                            'timestamp': event.get('timestamp'),
                        })

                if event_type == protocol.event_types.PARTICIPANT_VIDEO_ON:
                    participants = _extract_participants(event)
                    _upsert_video_participants(conn, participants)
                    snapshot = _video_participant_snapshot(conn)
                    emit('participant_video_on', {
                        'type': 'participant_video_on',
                        'participants': participants,
                        'available_participants': snapshot,
                        'data': event,
                        'rtmsId': meeting_uuid,
                        'meetingId': meeting_uuid,
                        'streamId': stream_id,
                        'productType': rtms_type,
                        'timestamp': event.get('timestamp'),
                    })
                    emit('video_on_participants_changed', {
                        'type': 'video_on_participants_changed',
                        'participants': participants,
                        'available_participants': snapshot,
                        'data': event,
                        'rtmsId': meeting_uuid,
                        'meetingId': meeting_uuid,
                        'streamId': stream_id,
                        'productType': rtms_type,
                        'timestamp': event.get('timestamp'),
                    })
                elif event_type == protocol.event_types.PARTICIPANT_VIDEO_OFF:
                    participants = _extract_participants(event)
                    removed = _remove_video_participants(conn, participants)
                    snapshot = _video_participant_snapshot(conn)
                    emit('participant_video_off', {
                        'type': 'participant_video_off',
                        'participants': participants,
                        'available_participants': snapshot,
                        'data': event,
                        'rtmsId': meeting_uuid,
                        'meetingId': meeting_uuid,
                        'streamId': stream_id,
                        'productType': rtms_type,
                        'timestamp': event.get('timestamp'),
                    })
                    emit('video_on_participants_changed', {
                        'type': 'video_on_participants_changed',
                        'participants': removed or participants,
                        'available_participants': snapshot,
                        'data': event,
                        'rtmsId': meeting_uuid,
                        'meetingId': meeting_uuid,
                        'streamId': stream_id,
                        'productType': rtms_type,
                        'timestamp': event.get('timestamp'),
                    })

                emit(
                    'event',
                    {
                        'type': 'event',
                        'eventType': event_type,
                        'data': event,
                        'rtmsId': meeting_uuid,
                        'meetingId': meeting_uuid,
                        'streamId': stream_id,
                        'productType': rtms_type,
                        'timestamp': event.get('timestamp'),
                    },
                )

            elif msg_type in (7, 8):
                FileLogger.log(f"[Signaling] [{rtms_type},{meeting_uuid},{stream_id}] Stream state: {msg}")
                if msg.get('state') == 4:
                    conn['should_reconnect'] = False
                emit(
                    'stream_state_changed',
                    {
                        'type': 'stream_state_changed',
                        'state': msg.get('state'),
                        'reason': msg.get('reason', None),
                        'data': msg,
                        'rtmsId': meeting_uuid,
                        'meetingId': meeting_uuid,
                        'streamId': stream_id,
                        'productType': rtms_type,
                    },
                )

            elif msg_type == 9:
                FileLogger.log(f"[Signaling] [{rtms_type},{meeting_uuid},{stream_id}] Session state: {msg}")
                if msg.get('state') == 5:
                    conn['should_reconnect'] = False
                emit(
                    'session_state_changed',
                    {
                        'type': 'session_state_changed',
                        'state': msg.get('state'),
                        'stopReason': msg.get('stop_reason', None),
                        'data': msg,
                        'rtmsId': meeting_uuid,
                        'meetingId': meeting_uuid,
                        'streamId': stream_id,
                        'productType': rtms_type,
                    },
                )

            elif msg_type == _get_protocol(conn).message_types.VIDEO_SUBSCRIPTION_RESP:
                success = msg.get('status_code') == 0
                subscribed = msg.get('subscribe', True)
                if success:
                    conn['current_video_subscription_user_id'] = msg.get('user_id') if subscribed else None

                emit(
                    'video_subscription_response',
                    {
                        'type': 'video_subscription_response',
                        'user_id': msg.get('user_id'),
                        'subscribed': subscribed,
                        'status_code': msg.get('status_code'),
                        'success': success,
                        'reason': msg.get('reason'),
                        'current_video_subscription_user_id': conn.get('current_video_subscription_user_id'),
                        'data': msg,
                        'rtmsId': meeting_uuid,
                        'meetingId': meeting_uuid,
                        'streamId': stream_id,
                        'productType': rtms_type,
                        'timestamp': msg.get('timestamp'),
                    },
                )

            elif msg_type == _get_protocol(conn).message_types.STREAM_CLOSE_RESP:
                emit(
                    'stream_close_response',
                    {
                        'type': 'stream_close_response',
                        'status_code': msg.get('status_code'),
                        'success': msg.get('status_code') == 0,
                        'reason': msg.get('reason'),
                        'data': msg,
                        'rtmsId': meeting_uuid,
                        'meetingId': meeting_uuid,
                        'streamId': stream_id,
                        'productType': rtms_type,
                        'timestamp': msg.get('timestamp'),
                    },
                )

    except websockets.exceptions.ConnectionClosed as e:
        FileLogger.log(f"[Signaling] [{rtms_type},{meeting_uuid},{stream_id}] Closed (code: {e.code})")
        conn['signaling']['state'] = 'closed'
        _release_signaling_connect_lock(conn, ws)
        if conn.get('signaling', {}).get('socket') is ws:
            conn['signaling']['socket'] = None

        if conn.get('_suppress_next_signaling_close_reconnect') is ws:
            conn['_suppress_next_signaling_close_reconnect'] = None
            return

        if conn.get('should_reconnect', False):
            FileLogger.log(f"[Signaling] [{rtms_type},{meeting_uuid},{stream_id}] Reconnecting in 3s...")
            async def _reconnect():
                await asyncio.sleep(3)
                conn.pop('_signaling_reconnect_task', None)
                if conn.get('should_reconnect', False):
                    await connect_to_signaling_websocket(
                        meeting_uuid, stream_id, conn['server_url'], conn,
                        client_id, client_secret, emit, conn['media_types_flag'],
                        on_media_url_received
                    )
            conn['_signaling_reconnect_task'] = asyncio.create_task(_reconnect())

    except Exception as e:
        FileLogger.error(f"[Signaling] [{rtms_type},{meeting_uuid},{stream_id}] Error: {e}")
        emit('error', {'message': str(e), 'meeting_id': meeting_uuid, 'rtms_id': meeting_uuid, 'stream_id': stream_id})
        conn['signaling']['state'] = 'error'
        _release_signaling_connect_lock(conn, ws)
