import asyncio
import json
from typing import Set, Dict, Any, Optional
from dataclasses import dataclass, field

from ..rtms_manager.utils.logger import FileLogger


@dataclass
class FrontendClient:
    websocket: Any
    meeting_uuid: Optional[str] = None
    user_id: Optional[str] = None
    registered: bool = False


class FrontendWssManager:
    def __init__(self, wss_path: str = '/ws', ping_interval: int = 10):
        self.wss_path = wss_path
        self.ping_interval = ping_interval
        self.clients: Set[FrontendClient] = set()
        self._ping_task: Optional[asyncio.Task] = None
        self._server = None

    async def setup_with_websockets(self, server):
        self._server = server
        self._ping_task = asyncio.create_task(self._ping_loop())
        FileLogger.log(f'[FrontendWssManager] WebSocket server initialized at {self.wss_path}')

    async def handle_connection(self, websocket, path: str = ''):
        if path != self.wss_path and self.wss_path not in path:
            return

        client = FrontendClient(websocket=websocket)
        self.clients.add(client)
        FileLogger.log('[FrontendWssManager] Frontend client connected (unregistered)')

        registration_timeout = 15
        
        async def check_registration():
            await asyncio.sleep(registration_timeout)
            if not client.registered:
                FileLogger.log('[FrontendWssManager] Registration timeout. Closing connection.')
                await self._send_to_client(client, {'type': 'error', 'message': 'Registration timeout'})
                await websocket.close()

        asyncio.create_task(check_registration())

        await self._send_to_client(client, {
            'type': 'connected', 
            'message': 'Connected to RTMS backend. Please register.'
        })

        try:
            async for message in websocket:
                try:
                    data = json.loads(message)
                except json.JSONDecodeError:
                    continue

                if data.get('type') == 'pong':
                    continue

                if data.get('type') == 'register':
                    meeting_uuid = data.get('meetingUUID')
                    user_id = data.get('userID')

                    if meeting_uuid and user_id:
                        client.meeting_uuid = meeting_uuid
                        client.user_id = user_id
                        client.registered = True
                        await self._send_to_client(client, {
                            'type': 'registration_success',
                            'meetingUUID': meeting_uuid,
                            'userID': user_id
                        })
                        FileLogger.log(f'[FrontendWssManager] Client registered: {user_id} for meeting {meeting_uuid}')
                    else:
                        FileLogger.log('[FrontendWssManager] Registration rejected: Invalid meetingUUID or userID')
                        await self._send_to_client(client, {'type': 'error', 'message': 'Registration invalid'})
                        await websocket.close()

        except Exception as e:
            FileLogger.error(f'[FrontendWssManager] WebSocket error: {e}')
        finally:
            self.clients.discard(client)
            info = f': {client.user_id} from {client.meeting_uuid}' if client.registered else ''
            FileLogger.log(f'[FrontendWssManager] Frontend client disconnected{info}')

    async def _send_to_client(self, client: FrontendClient, message: Dict[str, Any]):
        try:
            await client.websocket.send(json.dumps(message))
        except Exception:
            pass

    async def _ping_loop(self):
        while True:
            await asyncio.sleep(self.ping_interval)
            ping_msg = json.dumps({'type': 'ping'})
            for client in list(self.clients):
                try:
                    await client.websocket.send(ping_msg)
                except Exception:
                    self.clients.discard(client)

    def broadcast(self, message: Dict[str, Any]):
        asyncio.create_task(self._broadcast_async(message))

    async def _broadcast_async(self, message: Dict[str, Any]):
        msg_json = json.dumps(message)
        for client in list(self.clients):
            try:
                await client.websocket.send(msg_json)
            except Exception:
                self.clients.discard(client)

    def broadcast_to_meeting(self, meeting_uuid: str, message: Dict[str, Any]):
        asyncio.create_task(self._broadcast_to_meeting_async(meeting_uuid, message))

    async def _broadcast_to_meeting_async(self, meeting_uuid: str, message: Dict[str, Any]):
        msg_json = json.dumps(message)
        for client in list(self.clients):
            if client.meeting_uuid == meeting_uuid:
                try:
                    await client.websocket.send(msg_json)
                except Exception:
                    self.clients.discard(client)

    def broadcast_to_user(self, meeting_uuid: str, user_id: str, message: Dict[str, Any]):
        asyncio.create_task(self._broadcast_to_user_async(meeting_uuid, user_id, message))

    async def _broadcast_to_user_async(self, meeting_uuid: str, user_id: str, message: Dict[str, Any]):
        msg_json = json.dumps(message)
        for client in list(self.clients):
            if client.meeting_uuid == meeting_uuid and client.user_id == user_id:
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

        for client in list(self.clients):
            try:
                await client.websocket.close()
            except Exception:
                pass

        self.clients.clear()
        FileLogger.log('[FrontendWssManager] Stopped and cleaned up all connections')
