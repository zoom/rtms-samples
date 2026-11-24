import asyncio
import json
import random
import time
from datetime import datetime, timezone
from typing import Callable, Dict, Any, Optional, List
from urllib.parse import urlparse
import websockets
from websockets.client import WebSocketClientProtocol

from .utils.signature import generate_rtms_signature
from .utils.logger import FileLogger
from .utils.rtms_entity import build_rtms_entity_payload, get_preferred_media_url
from .utils.rtms_error import RTMSError, NON_RETRYABLE_CATEGORIES
from .utils.event_lookup import (
    get_rtms_session_state,
    get_rtms_stream_state,
    get_rtms_stop_reason,
    get_rtms_status_code,
)
from .utils.protocol_definitions import (
    DEFAULT_RTMS_PROTOCOL_VERSION,
    EVENT_CODE_TO_LEGACY_EVENT_TYPE,
    LEGACY_EVENT_TYPE_TO_EVENT_CODE,
    RTMS_EVENT_CODES,
    is_subscribable_event_code,
    merge_protocol_definitions,
    resolve_protocol_version,
)
from .utils.url_policy import select_allowed_rtms_callback_url


MAX_DUPLICATE_SIGNAL_RETRIES = 3
INITIAL_DUPLICATE_SIGNAL_RETRY_DELAY_SECONDS = 1.5

PHONE_EVENT_NAMES = {
    RTMS_EVENT_CODES['ZP_CALL_INFO_UPDATED']: 'phone_call_info_updated',
    RTMS_EVENT_CODES['ZP_CALL_HOLD']: 'phone_call_hold',
    RTMS_EVENT_CODES['ZP_CALL_RESUME']: 'phone_call_resume',
    RTMS_EVENT_CODES['ZP_CALL_TRANSFER_COMPLETED']: 'phone_call_transfer_completed',
}


def _get_protocol(conn: Dict[str, Any]):
    return merge_protocol_definitions(conn.get('config', {}).get('protocol_definitions', {}))


def get_protocol_version(conn: Dict[str, Any]) -> int:
    return resolve_protocol_version(
        conn.get('rtms_type', 'meeting'),
        conn.get('config', {}).get('protocol_version'),
    )


def _cancel_task(conn: Dict[str, Any], key: str):
    task = conn.get(key)
    if task:
        task.cancel()
        conn.pop(key, None)


def _release_signaling_connect_lock(conn: Dict[str, Any], ws: Optional[WebSocketClientProtocol]):
    if conn.get('_signaling_connect_ws') is ws:
        conn['_signaling_connect_locked'] = False
        conn['_signaling_connect_ws'] = None


async def _close_socket_quietly(ws: Optional[Any]):
    if not ws:
        return
    if not getattr(ws, 'closed', False):
        try:
            res = ws.close()
            if asyncio.iscoroutine(res):
                await res
        except Exception:
            pass


def _get_ws_host(url: str) -> str:
    try:
        parsed = urlparse(url)
        return parsed.netloc or 'unknown'
    except Exception:
        return 'unknown'


async def _measure_signaling_ping_rtt(
    ws: Any,
    meeting_uuid: str,
    stream_id: str,
    signaling_url: str,
    conn: Dict[str, Any],
    emit: Callable,
):
    ping_fn = getattr(ws, 'ping', None)
    if not callable(ping_fn):
        return
    host = _get_ws_host(signaling_url)
    rtms_type = conn.get('rtms_type', 'meeting')
    timeout_sec = (conn.get('config', {}).get('signaling_ping_timeout_ms') or 5000) / 1000.0
    started = time.monotonic()
    try:
        pong_waiter = await ping_fn()
        if pong_waiter is not None:
            await asyncio.wait_for(pong_waiter, timeout=timeout_sec)
        rtt_ms = int(round((time.monotonic() - started) * 1000))
        conn['ping_rtt'] = rtt_ms
        FileLogger.log(f"[Signaling] [{rtms_type},{meeting_uuid},{stream_id}] Ping RTT {rtt_ms}ms host={host}")
        emit('signaling_ping_rtt', {
            'type': 'signaling_ping_rtt',
            'rtmsId': meeting_uuid,
            'meetingId': meeting_uuid,
            'streamId': stream_id,
            'productType': rtms_type,
            'rttMs': rtt_ms,
            'signalingHost': host,
            'at': datetime.now(timezone.utc).isoformat(),
            'timestamp': int(time.time() * 1000),
        })
    except asyncio.TimeoutError:
        FileLogger.warn(
            f"[Signaling] [{rtms_type},{meeting_uuid},{stream_id}] Ping RTT probe timed out after {int(timeout_sec * 1000)}ms host={host}"
        )
    except Exception as e:
        FileLogger.warn(f"[Signaling] [{rtms_type},{meeting_uuid},{stream_id}] Ping RTT probe failed: {e}")


def _is_individual_video_enabled(conn: Dict[str, Any], media_types_flag: int) -> bool:
    protocol = _get_protocol(conn)
    requested_video = bool(media_types_flag & 2)
    video_data_opt = conn.get('config', {}).get('media_params', {}).get('video', {}).get('data_opt')
    return requested_video and video_data_opt == protocol.media_data_options.VIDEO_SINGLE_INDIVIDUAL_STREAM


def _build_event_subscription_payload(conn: Dict[str, Any], media_types_flag: int) -> Dict[str, Any]:
    protocol = _get_protocol(conn)
    subscribe_all = bool(conn.get('config', {}).get('subscribe_all_known_events'))
    if subscribe_all:
        known = [
            2, 3, 4, 5, 6, 7,
            protocol.event_types.PARTICIPANT_VIDEO_ON,
            protocol.event_types.PARTICIPANT_VIDEO_OFF,
            protocol.event_types.CHAT_GROUP_CREATE,
            protocol.event_types.CHAT_GROUP_DELETE,
            protocol.event_types.CHAT_GROUP_MEMBERS_ADD,
            protocol.event_types.CHAT_GROUP_MEMBERS_DELETE,
            protocol.event_types.CHAT_GROUP_MEMBER_STATUS_UPDATE,
        ]
        events = [{'event_type': et, 'subscribe': True} for et in dict.fromkeys(known)]
    else:
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
        if bool(media_types_flag & 16):
            events.extend([
                {'event_type': protocol.event_types.CHAT_GROUP_CREATE, 'subscribe': True},
                {'event_type': protocol.event_types.CHAT_GROUP_DELETE, 'subscribe': True},
                {'event_type': protocol.event_types.CHAT_GROUP_MEMBERS_ADD, 'subscribe': True},
                {'event_type': protocol.event_types.CHAT_GROUP_MEMBERS_DELETE, 'subscribe': True},
                {'event_type': protocol.event_types.CHAT_GROUP_MEMBER_STATUS_UPDATE, 'subscribe': True},
            ])

    if get_protocol_version(conn) < 2:
        return {'msg_type': 5, 'events': events}

    # V2 subscribes with event_code only (an entry with both fields returns
    # status 6), and only session events 1000-1011 are subscribable.
    v2_events = []
    seen = set()
    for entry in events:
        code = LEGACY_EVENT_TYPE_TO_EVENT_CODE.get(entry['event_type'])
        if not is_subscribable_event_code(code) or code in seen:
            continue
        seen.add(code)
        v2_events.append({'event_code': code, 'subscribe': entry['subscribe']})
    return {'msg_type': 5, 'events': v2_events}


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


def _normalize_phone_participant(participant: Dict[str, Any]) -> Dict[str, Any]:
    if not isinstance(participant, dict):
        return {'channel_id': None, 'name': None, 'number': None}
    number = participant.get('phone_number')
    if number is None:
        number = participant.get('extension_number')
    if number is None:
        number = participant.get('phone_number/extension_number')
    return {
        'channel_id': participant.get('channel_id'),
        'name': participant.get('name'),
        'number': number,
    }


def _extract_participants(event: Dict[str, Any]) -> List[Dict[str, Any]]:
    if isinstance(event.get('participants'), list) and event['participants']:
        return [
            {
                'user_id': participant.get('user_id'),
                'user_name': participant.get('user_name'),
            }
            for participant in event['participants']
            if isinstance(participant, dict) and participant.get('user_id') is not None
        ]

    if event.get('user_id') is None:
        return []

    return [{
        'user_id': event.get('user_id'),
        'user_name': event.get('user_name'),
    }]


def _upsert_video_participants(conn: Dict[str, Any], participants: List[Dict[str, Any]]):
    participant_map = conn.setdefault('video_on_participants', {})
    for participant in participants:
        key = str(participant['user_id'])
        existing = participant_map.get(key, {})
        participant_map[key] = {
            'user_id': participant['user_id'],
            'user_name': participant.get('user_name') or existing.get('user_name'),
        }


def _remove_video_participants(conn: Dict[str, Any], participants: List[Dict[str, Any]]):
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


def _video_participant_snapshot(conn: Dict[str, Any]) -> List[Dict[str, Any]]:
    return [participant.copy() for participant in conn.get('video_on_participants', {}).values()]


def _handle_event_code(
    event: Dict[str, Any],
    meeting_uuid: str,
    stream_id: str,
    conn: Dict[str, Any],
    emit: Callable,
):
    rtms_type = conn.get('rtms_type', 'meeting')
    event_code = event.get('event_code')
    base = {
        'eventCode': event_code,
        'data': event,
        'rtmsId': meeting_uuid,
        'meetingId': meeting_uuid,
        'streamId': stream_id,
        'productType': rtms_type,
        'timestamp': event.get('timestamp') or int(time.time() * 1000),
    }

    if event_code == RTMS_EVENT_CODES['FIRST_PACKET_TIMESTAMP']:
        FileLogger.log(f"[Signaling] [{rtms_type},{meeting_uuid},{stream_id}] FIRST_PACKET_TIMESTAMP: {event.get('timestamp')}")
        if conn.get('first_packet_timestamp') is None and event.get('timestamp') is not None:
            conn['first_packet_timestamp'] = event.get('timestamp')
    elif event_code == RTMS_EVENT_CODES['MEDIA_CONNECTION_INTERRUPTED']:
        FileLogger.log(
            f"[Signaling] [{rtms_type},{meeting_uuid},{stream_id}] MEDIA_CONNECTION_INTERRUPTED (media_type {event.get('media_type', 'unknown')})"
        )
        emit('media_connection_interrupted', {
            'type': 'media_connection_interrupted',
            'mediaType': event.get('media_type'),
            **base,
        })
    elif event_code == RTMS_EVENT_CODES['VIDEO_SUBSCRIPTION_TERMINATED_BY_USER_LEAVE']:
        conn['current_video_subscription_user_id'] = None
        emit('video_subscription_terminated', {
            'type': 'video_subscription_terminated',
            'connectionId': event.get('connection_id'),
            **base,
        })
    elif event_code == RTMS_EVENT_CODES['MEDIA_DATA_USER_INFO']:
        raw_participants = event.get('participants') if isinstance(event.get('participants'), list) else []
        participants = [
            {
                'user_id': p.get('user_id'),
                'user_name': p.get('user_name'),
                'participant_uuid': p.get('participant_uuid'),
                'userId': p.get('user_id'),
                'userName': p.get('user_name'),
                'participantUuid': p.get('participant_uuid'),
            }
            for p in raw_participants
            if isinstance(p, dict)
        ]
        emit('media_data_user_info', {
            'type': 'media_data_user_info',
            'mediaType': event.get('media_type'),
            'participants': participants,
            **base,
        })
    elif event_code == RTMS_EVENT_CODES['ZP_CALL_INFO_UPDATED']:
        raw_participants = event.get('participants') if isinstance(event.get('participants'), list) else []
        participants = [_normalize_phone_participant(p) for p in raw_participants]
        host_channel_id = event.get('host_channel_id')
        conn['phone_call_info'] = {
            'host_channel_id': host_channel_id,
            'participants': [p.copy() for p in participants],
        }
        names = ', '.join(str(p.get('name') or p.get('channel_id') or '') for p in participants)
        FileLogger.log(f"[Signaling] [{rtms_type},{meeting_uuid},{stream_id}] CALL_INFO_UPDATED: {names}")
        event_name = PHONE_EVENT_NAMES[event_code]
        emit(event_name, {
            'type': event_name,
            'host_channel_id': host_channel_id,
            'hostChannelId': host_channel_id,
            'participants': participants,
            **base,
        })
    elif event_code in (RTMS_EVENT_CODES['ZP_CALL_HOLD'], RTMS_EVENT_CODES['ZP_CALL_RESUME']):
        event_name = PHONE_EVENT_NAMES[event_code]
        FileLogger.log(f"[Signaling] [{rtms_type},{meeting_uuid},{stream_id}] {event_name}")
        emit(event_name, {
            'type': event_name,
            **base,
        })
    elif event_code == RTMS_EVENT_CODES['ZP_CALL_TRANSFER_COMPLETED']:
        event_name = PHONE_EVENT_NAMES[event_code]
        FileLogger.log(
            f"[Signaling] [{rtms_type},{meeting_uuid},{stream_id}] TRANSFER_COMPLETED: {event.get('transfer_type') or 'unknown'}"
        )
        emit(event_name, {
            'type': event_name,
            'transfer_type': event.get('transfer_type'),
            'transfer_result': event.get('transfer_result'),
            'transferType': event.get('transfer_type'),
            'transferResult': event.get('transfer_result'),
            **base,
        })
    else:
        FileLogger.log(f"[Signaling] [{rtms_type},{meeting_uuid},{stream_id}] Unhandled event_code: {event_code}")


async def connect_to_signaling_websocket(
    meeting_uuid: str,
    stream_id: str,
    server_url: str,
    conn: Dict[str, Any],
    client_id: str,
    client_secret: str,
    emit: Callable,
    media_types_flag: int,
    on_media_url_received: Optional[Callable] = None
) -> Optional[WebSocketClientProtocol]:
    rtms_type = conn.get('rtms_type', 'meeting')
    FileLogger.log(f"[Signaling] [{rtms_type},{meeting_uuid},{stream_id}] Connecting...")

    conn['meeting_uuid'] = meeting_uuid
    conn['stream_id'] = stream_id
    conn['server_url'] = server_url
    if 'media_types_flag' not in conn:
        conn['media_types_flag'] = media_types_flag

    # conn['server_url'] keeps the original value so reconnects reselect from it.
    signaling_url = select_allowed_rtms_callback_url(server_url)
    if not signaling_url:
        err = RTMSError.from_code(
            'CONNECTION_FAILED',
            message=f'Invalid or disallowed server URL: {server_url}',
            meeting_id=meeting_uuid,
            stream_id=stream_id,
        )
        FileLogger.error(f"[Signaling] [{rtms_type},{meeting_uuid},{stream_id}] {err.to_short_string()}")
        emit('error', err)
        conn['should_reconnect'] = False
        return None

    if conn.get('_signaling_connect_locked'):
        FileLogger.warn(f"[Signaling] [{rtms_type},{meeting_uuid},{stream_id}] Duplicate connect attempt blocked (connect already in progress).")
        return None

    existing_socket = conn.get('signaling', {}).get('socket')
    if existing_socket and not getattr(existing_socket, 'closed', False):
        FileLogger.warn(f"[Signaling] [{rtms_type},{meeting_uuid},{stream_id}] Duplicate connect attempt blocked (existing signaling socket still active).")
        return None

    _cancel_task(conn, '_signaling_reconnect_task')
    _cancel_task(conn, '_duplicate_signal_retry_task')
    conn['_signaling_connect_locked'] = True

    try:
        ws = await websockets.connect(signaling_url)
    except Exception as e:
        conn['_signaling_connect_locked'] = False
        conn['_signaling_connect_ws'] = None
        err = RTMSError.from_code(
            'CONNECTION_FAILED',
            message=f'Failed to create WebSocket: {e}',
            meeting_id=meeting_uuid,
            stream_id=stream_id,
            cause=e,
        )
        FileLogger.error(f"[Signaling] [{rtms_type},{meeting_uuid},{stream_id}] {err.to_short_string()}")
        emit('error', err)
        return None

    conn['_signaling_connect_ws'] = ws
    conn['signaling'] = {'socket': ws, 'state': 'connecting', 'last_keep_alive': None}

    FileLogger.log(f"[Signaling] [{rtms_type},{meeting_uuid},{stream_id}] Connected, sending handshake")
    asyncio.create_task(_measure_signaling_ping_rtt(ws, meeting_uuid, stream_id, signaling_url, conn, emit))

    if not conn.get('should_reconnect', True):
        FileLogger.warn(f"[Signaling] [{rtms_type},{meeting_uuid},{stream_id}] Aborting - RTMS stopped")
        await _close_socket_quietly(ws)
        _release_signaling_connect_lock(conn, ws)
        return None

    signature = generate_rtms_signature(meeting_uuid, stream_id, client_id, client_secret)

    handshake_msg = {
        'msg_type': 1,
        'protocol_version': get_protocol_version(conn),
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


async def handle_signaling_message(
    raw_message: Any,
    meeting_uuid: str,
    stream_id: str,
    ws: Any,
    conn: Dict[str, Any],
    emit: Callable,
    media_types_flag: int,
    client_id: str,
    client_secret: str,
    on_media_url_received: Optional[Callable] = None,
):
    rtms_type = conn.get('rtms_type', 'meeting')

    if isinstance(raw_message, dict):
        msg = dict(raw_message)
    else:
        try:
            data = raw_message if isinstance(raw_message, str) else raw_message.decode('utf-8')
            msg = json.loads(data)
        except (json.JSONDecodeError, UnicodeDecodeError):
            FileLogger.warn(f"[Signaling] [{rtms_type},{meeting_uuid},{stream_id}] Invalid JSON message")
            return

    # Zoom Phone event reference may send msg_type as the string "EVENT_UPDATE".
    if msg.get('msg_type') == 'EVENT_UPDATE':
        msg['msg_type'] = 6

    msg_type = msg.get('msg_type')
    protocol = _get_protocol(conn)

    if msg_type == 2:
        status = msg.get('status_code', msg.get('status'))
        status_text = get_rtms_status_code(status)
        is_duplicate_signal_request = 'duplicate signal request' in str(msg.get('reason', '')).lower()
        _release_signaling_connect_lock(conn, ws)

        if status == 0:
            media_server = msg.get('media_server', {})
            media_url = get_preferred_media_url(rtms_type, media_server.get('server_urls', {}))
            country_code = media_server.get('datacenter_region', 'unknown')

            FileLogger.log(
                f"[Signaling] [{rtms_type},{meeting_uuid},{stream_id}] Handshake response: status={status} ({status_text})"
            )
            FileLogger.log(
                f"[Signaling] [{rtms_type},{meeting_uuid},{stream_id}] Handshake OK. Media URL: {media_url} (Server: {str(country_code).upper()})"
            )
            conn.setdefault('signaling', {})['state'] = 'ready'
            conn['signaling'].setdefault('socket', ws)
            conn['media_server'] = media_server
            conn['has_connected_signaling'] = True
            conn['signaling_status8_failures'] = 0
            conn['_duplicate_signal_retry_count'] = 0
            _cancel_task(conn, '_duplicate_signal_retry_task')

            if on_media_url_received:
                await on_media_url_received(media_url, media_server)

            # Zoom Phone delivers call events (3000-3003) without subscription.
            if rtms_type == 'phone':
                conn['pending_event_subscription_payload'] = None
                conn['event_subscriptions_sent'] = True
            else:
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
                    return

                FileLogger.error(
                    f"[Signaling] [{rtms_type},{meeting_uuid},{stream_id}] Duplicate signal retries exhausted (status={status})"
                )

            if status == 8 and not conn.get('has_connected_signaling'):
                failures = conn.get('signaling_status8_failures', 0) + 1
                conn['signaling_status8_failures'] = failures
                if failures < 3:
                    FileLogger.warn(
                        f"[Signaling] [{rtms_type},{meeting_uuid},{stream_id}] Initial signaling handshake rejected with status 8; treating as transient startup rejection and waiting for reconnect (attempt {failures})."
                    )
                    return

            err = RTMSError.from_zoom_status(status, meeting_id=meeting_uuid, stream_id=stream_id)
            FileLogger.error(f"[Signaling] [{rtms_type},{meeting_uuid},{stream_id}] {err.to_short_string()}")

            if err.category in NON_RETRYABLE_CATEGORIES:
                conn['should_reconnect'] = False
                FileLogger.warn(
                    f"[Signaling] [{rtms_type},{meeting_uuid},{stream_id}] Disabling reconnect for non-retryable status {status}"
                )

            emit('error', err)

    elif msg_type == 12:
        conn.setdefault('signaling', {})['last_keep_alive'] = int(time.time() * 1000)
        pong_msg = {'msg_type': 13}
        if 'timestamp' in msg:
            pong_msg['timestamp'] = msg['timestamp']
        await ws.send(json.dumps(pong_msg))

    elif msg_type == 6:
        event = msg.get('event') or {}
        # V2 reports event_code. Session events (1000-1011) map onto the legacy
        # event_type handlers below; automatic and Phone codes have their own.
        raw_event_code = event.get('event_code')
        legacy_event_type = event.get('event_type')
        if legacy_event_type is None and is_subscribable_event_code(raw_event_code):
            legacy_event_type = EVENT_CODE_TO_LEGACY_EVENT_TYPE.get(raw_event_code)
        event_code = raw_event_code if raw_event_code is not None else LEGACY_EVENT_TYPE_TO_EVENT_CODE.get(legacy_event_type)

        if raw_event_code is not None and legacy_event_type is None:
            _handle_event_code(event, meeting_uuid, stream_id, conn, emit)
        else:
            if legacy_event_type == 1:
                FileLogger.log(f"[Signaling] [{rtms_type},{meeting_uuid},{stream_id}] FIRST_PACKET_TIMESTAMP: {event.get('timestamp')}")
                if conn.get('first_packet_timestamp') is None and event.get('timestamp') is not None:
                    conn['first_packet_timestamp'] = event.get('timestamp')
            elif legacy_event_type == 7:
                FileLogger.log(f"[Signaling] [{rtms_type},{meeting_uuid},{stream_id}] MEDIA_CONNECTION_INTERRUPTED")
                emit('media_connection_interrupted', {
                    'type': 'media_connection_interrupted',
                    'mediaType': event.get('media_type'),
                    'eventCode': event_code,
                    'data': event,
                    'rtmsId': meeting_uuid,
                    'meetingId': meeting_uuid,
                    'streamId': stream_id,
                    'productType': rtms_type,
                    'timestamp': event.get('timestamp'),
                })
            elif legacy_event_type == 4:
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
            elif legacy_event_type == protocol.event_types.PARTICIPANT_VIDEO_ON:
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
            elif legacy_event_type == protocol.event_types.PARTICIPANT_VIDEO_OFF:
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

            chat_event_names = {
                protocol.event_types.CHAT_GROUP_CREATE: 'chat_group_created',
                protocol.event_types.CHAT_GROUP_DELETE: 'chat_group_deleted',
                protocol.event_types.CHAT_GROUP_MEMBERS_ADD: 'chat_group_members_added',
                protocol.event_types.CHAT_GROUP_MEMBERS_DELETE: 'chat_group_members_removed',
                protocol.event_types.CHAT_GROUP_MEMBER_STATUS_UPDATE: 'chat_group_member_status_updated',
            }
            chat_event_name = chat_event_names.get(legacy_event_type)
            if chat_event_name:
                emit(chat_event_name, {
                    'type': chat_event_name,
                    'eventType': legacy_event_type,
                    'eventCode': event_code,
                    'data': event,
                    'rtmsId': meeting_uuid,
                    'meetingId': meeting_uuid,
                    'streamId': stream_id,
                    'productType': rtms_type,
                    'timestamp': event.get('timestamp'),
                })

        resolved_legacy_type = (
            legacy_event_type
            if legacy_event_type is not None
            else EVENT_CODE_TO_LEGACY_EVENT_TYPE.get(raw_event_code)
        )
        emit(
            'event',
            {
                'type': 'event',
                'eventType': resolved_legacy_type,
                'eventCode': event_code,
                'data': event,
                'rtmsId': meeting_uuid,
                'meetingId': meeting_uuid,
                'streamId': stream_id,
                'productType': rtms_type,
                'timestamp': event.get('timestamp'),
            },
        )

    elif msg_type == 8:
        reason = msg.get('reason')
        FileLogger.log(
            f"[Signaling] [{rtms_type},{meeting_uuid},{stream_id}] {get_rtms_stream_state(msg.get('state'))}, "
            f"reason: {'n/a' if reason is None else get_rtms_stop_reason(reason)}"
        )
        if msg.get('state') == 4:
            conn['should_reconnect'] = False
            conn.setdefault('signaling', {})['state'] = 'closed'
            await _close_socket_quietly(conn.get('signaling', {}).get('socket'))
            for media_obj in (conn.get('media') or {}).values():
                if isinstance(media_obj, dict):
                    task = media_obj.get('reconnect_task')
                    if task:
                        task.cancel()
                        media_obj['reconnect_task'] = None
                    await _close_socket_quietly(media_obj.get('socket'))
        emit(
            'stream_state_changed',
            {
                'type': 'stream_state_changed',
                'state': msg.get('state'),
                'reason': reason,
                'data': msg,
                'rtmsId': meeting_uuid,
                'meetingId': meeting_uuid,
                'streamId': stream_id,
                'productType': rtms_type,
                'timestamp': int(time.time() * 1000),
            },
        )

    elif msg_type == 9:
        stop_reason = msg.get('stop_reason')
        FileLogger.log(
            f"[Signaling] [{rtms_type},{meeting_uuid},{stream_id}] {get_rtms_session_state(msg.get('state'))}, "
            f"stop_reason: {'n/a' if stop_reason is None else get_rtms_stop_reason(stop_reason)}"
        )
        if msg.get('state') == 5:
            conn['should_reconnect'] = False
        emit(
            'session_state_changed',
            {
                'type': 'session_state_changed',
                'state': msg.get('state'),
                'stopReason': stop_reason,
                'data': msg,
                'rtmsId': meeting_uuid,
                'meetingId': meeting_uuid,
                'streamId': stream_id,
                'productType': rtms_type,
                'timestamp': int(time.time() * 1000),
            },
        )

    elif msg_type == protocol.message_types.VIDEO_SUBSCRIPTION_RESP:
        success = msg.get('status_code') == 0
        subscribed = msg.get('subscribe', True) is not False
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

    elif msg_type == 30:
        status = msg.get('status_code')
        err = RTMSError.from_zoom_status(
            status,
            meeting_id=meeting_uuid,
            stream_id=stream_id,
            request_msg_type=msg.get('request_msg_type'),
        )
        FileLogger.error(
            f"[Signaling] [{rtms_type},{meeting_uuid},{stream_id}] Request rejected "
            f"(request msg_type {msg.get('request_msg_type', 'unknown')}): {err.to_short_string()}"
        )
        emit('error', err)

    elif msg_type == protocol.message_types.STREAM_CLOSE_RESP:
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

            await handle_signaling_message(
                message, meeting_uuid, stream_id, ws, conn, emit,
                media_types_flag, client_id, client_secret, on_media_url_received
            )

    except websockets.exceptions.ConnectionClosed as e:
        FileLogger.log(f"[Signaling] [{rtms_type},{meeting_uuid},{stream_id}] Closed (code: {e.code})")
        conn.setdefault('signaling', {})['state'] = 'closed'
        _release_signaling_connect_lock(conn, ws)
        if conn.get('signaling', {}).get('socket') is ws:
            conn['signaling']['socket'] = None

        if conn.get('_suppress_next_signaling_close_reconnect') is ws:
            conn['_suppress_next_signaling_close_reconnect'] = None
            return

        if conn.get('should_reconnect', False):
            delay_sec = (conn.get('config', {}).get('reconnect_delay') or 3000) / 1000.0
            FileLogger.log(f"[Signaling] [{rtms_type},{meeting_uuid},{stream_id}] Reconnecting in {delay_sec:.1f}s...")

            async def _reconnect():
                await asyncio.sleep(delay_sec)
                conn.pop('_signaling_reconnect_task', None)
                if conn.get('should_reconnect', False):
                    await connect_to_signaling_websocket(
                        meeting_uuid, stream_id, conn['server_url'], conn,
                        client_id, client_secret, emit, conn['media_types_flag'],
                        on_media_url_received
                    )

            conn['_signaling_reconnect_task'] = asyncio.create_task(_reconnect())

    except Exception as e:
        err = RTMSError.from_code(
            'SIGNALING_ERROR',
            message=f'WebSocket error: {e}',
            meeting_id=meeting_uuid,
            stream_id=stream_id,
            cause=e,
        )
        FileLogger.error(f"[Signaling] [{rtms_type},{meeting_uuid},{stream_id}] {err.to_short_string()}")
        emit('error', err)
        conn.setdefault('signaling', {})['state'] = 'error'
        _release_signaling_connect_lock(conn, ws)
