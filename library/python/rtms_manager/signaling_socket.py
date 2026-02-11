import asyncio
import json
import random
from typing import Callable, Dict, Any, Optional
import websockets
from websockets.client import WebSocketClientProtocol

from .utils.signature import generate_rtms_signature
from .utils.logger import FileLogger


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

    if not server_url or not server_url.startswith('ws'):
        FileLogger.error(f"[Signaling] [{rtms_type},{meeting_uuid},{stream_id}] Invalid server URL: {server_url}")
        emit('error', {'message': 'Invalid server URL', 'meeting_id': meeting_uuid, 'stream_id': stream_id})
        conn['should_reconnect'] = False
        return None

    # Guard: Close any existing signaling socket before creating a new one
    existing_socket = conn.get('signaling', {}).get('socket')
    if existing_socket and existing_socket.open:
        FileLogger.warn(f"[Signaling] [{rtms_type},{meeting_uuid},{stream_id}] Closing existing socket before reconnecting")
        try:
            await existing_socket.close()
        except Exception:
            pass
        conn['signaling']['socket'] = None
    
    # Cancel any pending reconnect task
    reconnect_task = conn.get('_signaling_reconnect_task')
    if reconnect_task:
        reconnect_task.cancel()
        conn.pop('_signaling_reconnect_task', None)

    try:
        ws = await websockets.connect(server_url)
    except Exception as e:
        FileLogger.error(f"[Signaling] [{rtms_type},{meeting_uuid},{stream_id}] Connection failed: {e}")
        emit('error', {'message': str(e), 'meeting_id': meeting_uuid, 'stream_id': stream_id})
        return None

    conn['meeting_uuid'] = meeting_uuid
    conn['stream_id'] = stream_id
    conn['server_url'] = server_url
    conn['signaling'] = {'socket': ws, 'state': 'connecting'}
    if 'media_types_flag' not in conn:
        conn['media_types_flag'] = media_types_flag

    FileLogger.log(f"[Signaling] [{rtms_type},{meeting_uuid},{stream_id}] Connected, sending handshake")

    if not conn.get('should_reconnect', True):
        FileLogger.warn(f"[Signaling] [{rtms_type},{meeting_uuid},{stream_id}] Aborting - RTMS stopped")
        await ws.close()
        return None

    signature = generate_rtms_signature(meeting_uuid, stream_id, client_id, client_secret)

    handshake_msg = {
        'msg_type': 1,
        'protocol_version': 1,
        'meeting_uuid': meeting_uuid,
        'rtms_stream_id': stream_id,
        'sequence': random.randint(0, 10**9),
        'signature': signature,
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
            try:
                data = message if isinstance(message, str) else message.decode('utf-8')
                msg = json.loads(data)
            except (json.JSONDecodeError, UnicodeDecodeError):
                continue

            msg_type = msg.get('msg_type')

            if msg_type == 2:
                status = msg.get('status')
                if status == 0:
                    media_server = msg.get('media_server', {})
                    media_url = media_server.get('server_urls', {}).get('all', '')
                    country_code = media_server.get('datacenter_region', 'unknown')
                    
                    FileLogger.log(f"[Signaling] [{rtms_type},{meeting_uuid},{stream_id}] Handshake OK. Media URL: {media_url} (Server: {country_code.upper()})")
                    conn['signaling']['state'] = 'ready'
                    conn['media_server'] = media_server

                    if on_media_url_received:
                        await on_media_url_received(media_url, media_server)
                else:
                    FileLogger.error(f"[Signaling] [{rtms_type},{meeting_uuid},{stream_id}] Handshake failed: status={status}")
                    emit('error', {'message': f'Handshake failed: {status}', 'meeting_id': meeting_uuid})

            elif msg_type == 12:
                pong_msg = {'msg_type': 13}
                await ws.send(json.dumps(pong_msg))

            elif msg_type == 7:
                FileLogger.log(f"[Signaling] [{rtms_type},{meeting_uuid},{stream_id}] Stream state: {msg}")
                emit('stream_state_changed', msg, meeting_uuid, stream_id, rtms_type)

            elif msg_type == 8:
                FileLogger.log(f"[Signaling] [{rtms_type},{meeting_uuid},{stream_id}] Session state: {msg}")
                emit('session_state_changed', msg, meeting_uuid, stream_id, rtms_type)

    except websockets.exceptions.ConnectionClosed as e:
        FileLogger.log(f"[Signaling] [{rtms_type},{meeting_uuid},{stream_id}] Closed (code: {e.code})")
        conn['signaling']['state'] = 'closed'

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
        emit('error', {'message': str(e), 'meeting_id': meeting_uuid, 'stream_id': stream_id})
        conn['signaling']['state'] = 'error'
