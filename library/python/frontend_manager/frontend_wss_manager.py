import asyncio
import inspect
import json
from dataclasses import dataclass
from typing import Any, Callable, Dict, Optional, Set, Union

try:
    from ..rtms_manager.utils.logger import FileLogger
except ImportError:
    from rtms_manager.utils.logger import FileLogger


@dataclass(eq=False)
class FrontendClient:
    websocket: Any
    meeting_uuid: Optional[str] = None
    user_id: Optional[str] = None
    registered: bool = False


class FrontendWssManager:
    def __init__(
        self,
        wss_path: str = '/ws',
        ping_interval: int = 10,
        authorize_registration: Optional[Callable[[Dict[str, Any]], Any]] = None,
        max_payload_bytes: int = 64 * 1024,
        registration_timeout: int = 15,
        logger: Any = None,
        config: Optional[Dict[str, Any]] = None,
    ):
        cfg = config or {}
        self.config = cfg
        self.wss_path = cfg.get('frontend_wss_path', cfg.get('frontendWssPath', wss_path))
        self.ping_interval = ping_interval
        self.max_payload_bytes = int(
            cfg.get('frontend_wss_max_payload_bytes', cfg.get('frontendWssMaxPayloadBytes', max_payload_bytes))
        )
        self.registration_timeout = registration_timeout
        self.authorize_registration = (
            authorize_registration
            or cfg.get('authorize_registration')
            or cfg.get('authorizeRegistration')
        )
        self.logger = logger or FileLogger
        self.clients: Set[FrontendClient] = set()
        self._ping_task: Optional[asyncio.Task] = None
        self._server = None

    async def setup_with_websockets(self, server):
        if self.config.get('frontend_wss_enabled') is False or self.config.get('frontendWssEnabled') is False:
            self.logger.log('[FrontendWssManager] Frontend WSS skipped')
            return
        self._server = server
        self._ping_task = asyncio.create_task(self._ping_loop())
        self.logger.log(f'[FrontendWssManager] WebSocket server initialized at {self.wss_path}')

    async def validate_registration(self, context: Dict[str, Any]) -> Dict[str, Any]:
        """Fail closed unless an authorize_registration callback approves the client."""
        meeting_uuid = context.get('meeting_uuid', context.get('meetingUUID'))
        user_id = context.get('user_id', context.get('userID'))
        if not meeting_uuid or user_id is None or not callable(self.authorize_registration):
            return {'authorized': False}

        normalized_context = {
            **context,
            'meeting_uuid': meeting_uuid,
            'meetingUUID': meeting_uuid,
            'user_id': user_id,
            'userID': user_id,
        }
        result = self.authorize_registration(normalized_context)
        if inspect.isawaitable(result):
            result = await result

        if result is True:
            return {
                'authorized': True,
                'meeting_uuid': str(meeting_uuid),
                'meetingUUID': str(meeting_uuid),
                'user_id': str(user_id),
                'userID': str(user_id),
            }
        if isinstance(result, dict) and result.get('authorized') is True:
            canonical_meeting = result.get('meeting_uuid', result.get('meetingUUID', meeting_uuid))
            canonical_user = result.get('user_id', result.get('userID', user_id))
            return {
                **result,
                'authorized': True,
                'meeting_uuid': str(canonical_meeting),
                'meetingUUID': str(canonical_meeting),
                'user_id': str(canonical_user),
                'userID': str(canonical_user),
            }
        return {'authorized': False}

    async def handle_connection(self, websocket, path: str = '', request: Any = None):
        if path and path != self.wss_path and self.wss_path not in path:
            return

        client = FrontendClient(websocket=websocket)
        self.clients.add(client)
        self.logger.log('[FrontendWssManager] Frontend client connected (unregistered)')

        async def check_registration():
            try:
                await asyncio.sleep(self.registration_timeout)
                if not client.registered:
                    self.logger.log('[FrontendWssManager] Registration timeout. Closing connection.')
                    await self._send_to_client(client, {'type': 'error', 'message': 'Registration timeout'})
                    await websocket.close()
            except asyncio.CancelledError:
                pass

        timeout_task = asyncio.create_task(check_registration())

        await self._send_to_client(client, {
            'type': 'connected',
            'message': 'Connected to RTMS backend. Please register.',
        })

        try:
            async for message in websocket:
                raw_size = len(message.encode('utf-8')) if isinstance(message, str) else len(message)
                if self.max_payload_bytes > 0 and raw_size > self.max_payload_bytes:
                    self.logger.warn('[FrontendWssManager] Client message exceeded max payload size')
                    await self._send_to_client(client, {'type': 'error', 'message': 'Payload too large'})
                    await websocket.close(1009, 'Message too big')
                    break

                try:
                    data = json.loads(message)
                except (json.JSONDecodeError, TypeError):
                    await self._send_to_client(client, {'type': 'error', 'message': 'Invalid message'})
                    continue

                if not isinstance(data, dict):
                    await self._send_to_client(client, {'type': 'error', 'message': 'Invalid message'})
                    continue

                if data.get('type') == 'pong':
                    continue

                if data.get('type') == 'register':
                    meeting_uuid = data.get('meetingUUID', data.get('meeting_uuid'))
                    user_id = data.get('userID', data.get('user_id'))
                    token = data.get('token')

                    registration = await self.validate_registration({
                        'meetingUUID': meeting_uuid,
                        'userID': user_id,
                        'token': token,
                        'request': request,
                        'socket': websocket,
                    })

                    if registration.get('authorized'):
                        client.meeting_uuid = str(registration.get('meetingUUID', meeting_uuid))
                        client.user_id = str(registration.get('userID', user_id))
                        client.registered = True
                        timeout_task.cancel()
                        await self._send_to_client(client, {
                            'type': 'registration_success',
                            'meetingUUID': client.meeting_uuid,
                            'userID': client.user_id,
                        })
                        self.logger.log(
                            f'[FrontendWssManager] Client registered: {client.user_id} for meeting {client.meeting_uuid}'
                        )
                    else:
                        self.logger.warn('[FrontendWssManager] Registration rejected')
                        await self._send_to_client(client, {'type': 'error', 'message': 'Registration unauthorized'})
                        await websocket.close()
                        break

        except Exception as e:
            self.logger.error(f'[FrontendWssManager] WebSocket error: {e}')
        finally:
            timeout_task.cancel()
            self.clients.discard(client)
            info = f': {client.user_id} from {client.meeting_uuid}' if client.registered else ''
            self.logger.log(f'[FrontendWssManager] Frontend client disconnected{info}')

    async def _send_to_client(self, client: FrontendClient, message: Union[str, Dict[str, Any]]):
        try:
            payload = message if isinstance(message, str) else json.dumps(message)
            await client.websocket.send(payload)
        except Exception:
            pass

    @staticmethod
    def _is_registered(client: FrontendClient) -> bool:
        return bool(client.registered and client.meeting_uuid and client.user_id is not None)

    async def _ping_loop(self):
        while True:
            await asyncio.sleep(self.ping_interval)
            ping_msg = json.dumps({'type': 'ping'})
            for client in list(self.clients):
                try:
                    await client.websocket.send(ping_msg)
                except Exception:
                    self.clients.discard(client)

    def broadcast(self, message: Union[str, Dict[str, Any]]):
        asyncio.create_task(self._broadcast_async(message))

    broadcast_to_frontend_clients = broadcast

    async def _broadcast_async(self, message: Union[str, Dict[str, Any]]):
        msg_json = message if isinstance(message, str) else json.dumps(message)
        for client in list(self.clients):
            if not self._is_registered(client):
                continue
            try:
                await client.websocket.send(msg_json)
            except Exception:
                self.clients.discard(client)

    def broadcast_to_meeting(self, meeting_uuid: str, message: Union[str, Dict[str, Any]]):
        asyncio.create_task(self._broadcast_to_meeting_async(meeting_uuid, message))

    async def _broadcast_to_meeting_async(self, meeting_uuid: str, message: Union[str, Dict[str, Any]]):
        msg_json = message if isinstance(message, str) else json.dumps(message)
        target_meeting = str(meeting_uuid)
        for client in list(self.clients):
            if self._is_registered(client) and str(client.meeting_uuid) == target_meeting:
                try:
                    await client.websocket.send(msg_json)
                except Exception:
                    self.clients.discard(client)

    def broadcast_to_user(self, meeting_uuid: str, user_id: str, message: Union[str, Dict[str, Any]]):
        asyncio.create_task(self._broadcast_to_user_async(meeting_uuid, user_id, message))

    async def _broadcast_to_user_async(self, meeting_uuid: str, user_id: str, message: Union[str, Dict[str, Any]]):
        msg_json = message if isinstance(message, str) else json.dumps(message)
        target_meeting = str(meeting_uuid)
        target_user = str(user_id)
        for client in list(self.clients):
            if (
                self._is_registered(client)
                and str(client.meeting_uuid) == target_meeting
                and str(client.user_id) == target_user
            ):
                try:
                    await client.websocket.send(msg_json)
                except Exception:
                    self.clients.discard(client)

    async def stop(self):
        if self._ping_task:
            self._ping_task.cancel()
            try:
                await self._ping_task
            except asyncio.CancelledError:
                pass
            self._ping_task = None

        for client in list(self.clients):
            try:
                await client.websocket.close(1000, 'Server shutting down')
            except TypeError:
                try:
                    await client.websocket.close()
                except Exception:
                    pass
            except Exception:
                pass

        self.clients.clear()
        if self._server and hasattr(self._server, 'close'):
            try:
                self._server.close()
            except Exception as err:
                self.logger.error(f'[FrontendWssManager] Error closing WebSocket server: {err}')
            self._server = None

        self.logger.log('[FrontendWssManager] Stopped and cleaned up all connections')
