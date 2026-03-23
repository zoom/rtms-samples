import asyncio
import json
import time
from typing import Dict, Any, Callable, Optional, List
from dataclasses import dataclass, field

from .utils.logger import FileLogger
from .utils.config import RTMSConfig, RTMSConfigHelper, Credentials
from .utils.media_params import MediaType, RTMS_MEDIA_PARAMS
from .utils.rtms_entity import get_preferred_media_url, get_rtms_id_from_payload
from .utils.protocol_definitions import RTMS_PROTOCOL_DEFINITIONS
from .signaling_socket import connect_to_signaling_websocket
from .media_socket import connect_to_media_websocket, TYPE_FLAGS


def calculate_effective_flags(requested_flags: int, server_urls: Dict[str, Any]) -> int:
    if requested_flags != MediaType.ALL:
        return requested_flags

    effective_flags = 0
    for type_name, flag in TYPE_FLAGS.items():
        if type_name == 'all':
            continue
        if isinstance(server_urls, dict) and server_urls.get(type_name):
            effective_flags |= flag
    return effective_flags


@dataclass
class StreamConnection:
    rtms_id: str
    rtms_type: str
    stream_id: str
    server_url: str
    client_id: str
    client_secret: str
    config: Dict[str, Any]
    should_reconnect: bool = True
    signaling: Dict[str, Any] = field(default_factory=dict)
    media: Dict[str, Any] = field(default_factory=dict)
    media_config: Optional[Dict[str, Any]] = None
    media_server: Optional[Dict[str, Any]] = None
    start_time: Optional[int] = None
    first_packet_timestamp: Optional[int] = None
    last_packet_timestamp: Optional[int] = None
    has_connected_signaling: bool = False
    signaling_status8_failures: int = 0
    video_on_participants: Dict[str, Dict[str, Any]] = field(default_factory=dict)
    current_video_subscription_user_id: Optional[Any] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            'rtms_id': self.rtms_id,
            'rtms_type': self.rtms_type,
            'stream_id': self.stream_id,
            'server_url': self.server_url,
            'should_reconnect': self.should_reconnect,
            'signaling': self.signaling,
            'media': {k: {'state': v.get('state')} for k, v in self.media.items()},
            'start_time': self.start_time,
            'video_on_participants': list(self.video_on_participants.values()),
            'current_video_subscription_user_id': self.current_video_subscription_user_id,
        }


class RTMSManager:
    _instance: Optional['RTMSManager'] = None
    
    MEDIA = MediaType
    MEDIA_PARAMS = RTMS_MEDIA_PARAMS
    PROTOCOL = RTMS_PROTOCOL_DEFINITIONS
    
    PRESETS = {
        'AUDIO_ONLY': {
            'media_types': MediaType.AUDIO,
        },
        'TRANSCRIPTION': {
            'media_types': MediaType.AUDIO | MediaType.TRANSCRIPT,
        },
        'VIDEO_RECORDING': {
            'media_types': MediaType.AUDIO | MediaType.VIDEO,
        },
        'FULL_MEDIA': {
            'media_types': MediaType.ALL,
        },
    }

    def __new__(cls, *args, **kwargs):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance._initialized = False
        return cls._instance

    def __init__(self, config: Optional[RTMSConfig] = None):
        if self._initialized:
            return
        
        self._config = config or RTMSConfig()
        self._state = 'INITIALIZED'
        self._connections: Dict[str, StreamConnection] = {}
        self._stream_history: Dict[str, Dict[str, Any]] = {}
        self._event_handlers: Dict[str, List[Callable]] = {}
        self._initialized = True

    @classmethod
    async def init(cls, options: Dict[str, Any] = None) -> 'RTMSManager':
        if cls._instance and cls._instance._initialized:
            FileLogger.warn('[RTMSManager] Already initialized. Returning existing instance.')
            return cls._instance

        config = RTMSConfigHelper.merge(options or {})

        if config.log_dir:
            FileLogger.set_log_dir(config.log_dir)
        if config.logging and config.logging != 'off':
            FileLogger.set_level(config.logging)
        else:
            FileLogger.set_level('off')

        instance = cls(config)
        await instance.start()
        return instance

    @classmethod
    def instance(cls) -> 'RTMSManager':
        if cls._instance is None or not cls._instance._initialized:
            raise RuntimeError('RTMSManager not initialized. Call await RTMSManager.init() first.')
        return cls._instance

    def on(self, event: str, handler: Callable):
        if event not in self._event_handlers:
            self._event_handlers[event] = []
        self._event_handlers[event].append(handler)

    def off(self, event: str, handler: Callable):
        if event in self._event_handlers:
            self._event_handlers[event] = [h for h in self._event_handlers[event] if h != handler]

    def emit(self, event: str, *args, **kwargs):
        if event in self._event_handlers:
            for handler in self._event_handlers[event]:
                try:
                    result = handler(*args, **kwargs)
                    if asyncio.iscoroutine(result):
                        asyncio.create_task(result)
                except Exception as e:
                    FileLogger.error(f'[RTMSManager] Event handler error for {event}: {e}')

    async def start(self):
        if self._state == 'STARTED':
            FileLogger.warn('[RTMSManager] Manager already started.')
            return

        self._state = 'STARTED'
        
        self._setup_internal_handlers()
        
        FileLogger.info('[RTMSManager] Ready - feed RTMS events via emit(event, payload)')

    def _setup_internal_handlers(self):
        self.on('meeting.rtms_started', self._on_meeting_started)
        self.on('meeting.rtms_stopped', self._on_meeting_stopped)
        self.on('session.rtms_started', self._on_session_started)
        self.on('session.rtms_stopped', self._on_session_stopped)
        self.on('webinar.rtms_started', self._on_webinar_started)
        self.on('webinar.rtms_stopped', self._on_webinar_stopped)
        self.on('contact_center.voice_rtms_started', self._on_contact_center_started)
        self.on('contact_center.voice_rtms_stopped', self._on_contact_center_stopped)
        self.on('phone.rtms_started', self._on_phone_started)
        self.on('phone.rtms_stopped', self._on_phone_stopped)
        self.on('stream_state_changed', self._on_stream_state_changed)
        self.on('session_state_changed', self._on_session_state_changed)

    def _on_meeting_started(self, payload: Dict[str, Any]):
        meeting_uuid = payload.get('meeting_uuid')
        stream_id = payload.get('rtms_stream_id')
        server_urls = payload.get('server_urls')
        event_ts = payload.get('event_ts')
        creds = RTMSConfigHelper.get_credentials_for_product('meeting', self._config)
        asyncio.create_task(self._on_stream_start(meeting_uuid, 'meeting', stream_id, server_urls, creds, event_ts))

    def _on_meeting_stopped(self, payload: Dict[str, Any]):
        stream_id = payload.get('rtms_stream_id')
        asyncio.create_task(self._on_stream_stop(stream_id))

    def _on_session_started(self, payload: Dict[str, Any]):
        session_id = payload.get('session_id')
        stream_id = payload.get('rtms_stream_id')
        server_urls = payload.get('server_urls')
        event_ts = payload.get('event_ts')
        creds = RTMSConfigHelper.get_credentials_for_product('video_sdk', self._config)
        asyncio.create_task(self._on_stream_start(session_id, 'video_sdk', stream_id, server_urls, creds, event_ts))

    def _on_session_stopped(self, payload: Dict[str, Any]):
        stream_id = payload.get('rtms_stream_id')
        asyncio.create_task(self._on_stream_stop(stream_id))

    def _on_webinar_started(self, payload: Dict[str, Any]):
        webinar_uuid = payload.get('webinar_uuid')
        stream_id = payload.get('rtms_stream_id')
        server_urls = payload.get('server_urls')
        event_ts = payload.get('event_ts')
        creds = RTMSConfigHelper.get_credentials_for_product('webinar', self._config)
        asyncio.create_task(self._on_stream_start(webinar_uuid, 'webinar', stream_id, server_urls, creds, event_ts))

    def _on_webinar_stopped(self, payload: Dict[str, Any]):
        stream_id = payload.get('rtms_stream_id')
        asyncio.create_task(self._on_stream_stop(stream_id))

    def _on_contact_center_started(self, payload: Dict[str, Any]):
        engagement_id = get_rtms_id_from_payload('contact_center', payload)
        stream_id = payload.get('rtms_stream_id')
        server_urls = payload.get('server_urls')
        event_ts = payload.get('event_ts')
        creds = RTMSConfigHelper.get_credentials_for_product('contact_center', self._config)
        asyncio.create_task(self._on_stream_start(engagement_id, 'contact_center', stream_id, server_urls, creds, event_ts))

    def _on_contact_center_stopped(self, payload: Dict[str, Any]):
        stream_id = payload.get('rtms_stream_id')
        asyncio.create_task(self._on_stream_stop(stream_id))

    def _on_phone_started(self, payload: Dict[str, Any]):
        call_id = get_rtms_id_from_payload('phone', payload)
        stream_id = payload.get('rtms_stream_id')
        server_urls = payload.get('server_urls')
        event_ts = payload.get('event_ts')
        creds = RTMSConfigHelper.get_credentials_for_product('phone', self._config)
        asyncio.create_task(self._on_stream_start(call_id, 'phone', stream_id, server_urls, creds, event_ts))

    def _on_phone_stopped(self, payload: Dict[str, Any]):
        stream_id = payload.get('rtms_stream_id')
        asyncio.create_task(self._on_stream_stop(stream_id))

    def _on_stream_state_changed(self, payload: Dict[str, Any], *_args):
        if payload.get('state') == 4 and payload.get('streamId'):
            asyncio.create_task(self._on_stream_stop(payload.get('streamId')))

    def _on_session_state_changed(self, payload: Dict[str, Any], *_args):
        if payload.get('state') == 5 and payload.get('streamId'):
            asyncio.create_task(self._on_stream_stop(payload.get('streamId')))

    def _find_connection_by_rtms_id(self, rtms_id: str) -> Optional[StreamConnection]:
        for conn in self._connections.values():
            if conn.rtms_id == rtms_id:
                return conn
        return None

    async def _on_stream_start(
        self, 
        rtms_id: str, 
        rtms_type: str, 
        stream_id: str, 
        server_url: str,
        creds: Credentials,
        start_time: Optional[int] = None
    ):
        existing_conn = self._find_connection_by_rtms_id(rtms_id)
        if existing_conn:
            if existing_conn.stream_id == stream_id:
                FileLogger.warn(f'[RTMSManager] Duplicate stream ID {stream_id} for {rtms_type} {rtms_id}')
                return

            FileLogger.warn(
                f'[RTMSManager] Replacing stale {existing_conn.rtms_type} {rtms_id} stream {existing_conn.stream_id} with new stream {stream_id}'
            )
            await self._on_stream_stop(existing_conn.stream_id)

        if stream_id in self._connections:
            FileLogger.warn(f'[RTMSManager] Duplicate stream ID {stream_id} for {rtms_type} {rtms_id}')
            return

        FileLogger.info(f'[RTMSManager] Starting {rtms_type} {rtms_id} stream {stream_id}')

        transcript_params = {
            'content_type': self._config.media_params.transcript.content_type,
        }
        if self._config.media_params.transcript.language is not None:
            transcript_params['language'] = self._config.media_params.transcript.language
        if self._config.media_params.transcript.src_language is not None:
            transcript_params['src_language'] = self._config.media_params.transcript.src_language
        if self._config.media_params.transcript.enable_lid is not None:
            transcript_params['enable_lid'] = self._config.media_params.transcript.enable_lid

        media_params = {
            'audio': {
                'content_type': self._config.media_params.audio.content_type,
                'sample_rate': self._config.media_params.audio.sample_rate,
                'channel': self._config.media_params.audio.channel,
                'codec': self._config.media_params.audio.codec,
                'data_opt': self._config.media_params.audio.data_opt,
                'send_rate': self._config.media_params.audio.send_rate,
            },
            'video': {
                'content_type': self._config.media_params.video.content_type,
                'codec': self._config.media_params.video.codec,
                'data_opt': self._config.media_params.video.data_opt,
                'resolution': self._config.media_params.video.resolution,
                'fps': self._config.media_params.video.fps,
            },
            'deskshare': {
                'content_type': self._config.media_params.deskshare.content_type,
                'codec': self._config.media_params.deskshare.codec,
                'resolution': self._config.media_params.deskshare.resolution,
                'fps': self._config.media_params.deskshare.fps,
            },
            'chat': {'content_type': self._config.media_params.chat.content_type},
            'transcript': transcript_params,
        }

        conn = StreamConnection(
            rtms_id=rtms_id,
            rtms_type=rtms_type,
            stream_id=stream_id,
            server_url=server_url,
            client_id=creds.client_id,
            client_secret=creds.client_secret,
            config={
                'media_params': media_params,
                'media_types_flag': self._config.media_types,
                'protocol_definitions': self._config.protocol_definitions.to_dict(),
            },
            start_time=start_time,
        )
        self._connections[stream_id] = conn

        conn_state = conn.__dict__

        async def on_media_url_received(media_url: str, media_server: Dict[str, Any]):
            effective_flags = calculate_effective_flags(
                self._config.media_types,
                media_server.get('server_urls', {}) if isinstance(media_server, dict) else {},
            )

            unified_media_url = None
            if isinstance(media_server, dict):
                server_urls = media_server.get('server_urls', {})
                if isinstance(server_urls, dict):
                    unified_media_url = server_urls.get('all')

            if self._config.use_unified_media_socket and unified_media_url:
                await connect_to_media_websocket(
                    unified_media_url, rtms_id, stream_id, conn_state,
                    creds.client_id, creds.client_secret,
                    'all', MediaType.ALL if self._config.media_types == MediaType.ALL else effective_flags, self.emit
                )
            else:
                if self._config.use_unified_media_socket:
                    FileLogger.warn(
                        f'[RTMSManager] Unified media socket requested for {rtms_type} {rtms_id}, but media_server.server_urls.all is unavailable. Falling back to split media sockets.'
                    )
                for type_name, flag in TYPE_FLAGS.items():
                    if type_name == 'all':
                        continue
                    if effective_flags & flag:
                        type_url = get_preferred_media_url(rtms_type, media_server.get('server_urls', {}), type_name) or media_url
                        await connect_to_media_websocket(
                            type_url, rtms_id, stream_id, conn_state,
                            creds.client_id, creds.client_secret,
                            type_name, flag, self.emit
                        )

        await connect_to_signaling_websocket(
            rtms_id, stream_id, server_url, conn_state,
            creds.client_id, creds.client_secret,
            self.emit, self._config.media_types, on_media_url_received
        )

    async def _on_stream_stop(self, stream_id: str):
        conn = self._connections.get(stream_id)
        if not conn:
            FileLogger.warn(f'[RTMSManager] No handler found for streamId {stream_id}')
            return

        FileLogger.info(f'[RTMSManager] Stopping {conn.rtms_type} {conn.rtms_id} stream {stream_id}')
        
        conn.should_reconnect = False

        if conn.signaling.get('socket'):
            try:
                await conn.signaling['socket'].close()
            except Exception:
                pass

        for media_type, media_obj in conn.media.items():
            if media_obj.get('socket'):
                try:
                    await media_obj['socket'].close()
                except Exception:
                    pass

        self._stream_history[stream_id] = {
            'rtms_id': conn.rtms_id,
            'rtms_type': conn.rtms_type,
            'stream_id': conn.stream_id,
            'start_time': conn.start_time,
            'end_time': asyncio.get_event_loop().time(),
            'media_config': conn.media_config,
            'video_on_participants': list(conn.video_on_participants.values()),
            'current_video_subscription_user_id': conn.current_video_subscription_user_id,
        }

        del self._connections[stream_id]

    async def stop(self):
        if self._state != 'STARTED':
            FileLogger.warn('[RTMSManager] Manager not started.')
            return

        for stream_id, conn in list(self._connections.items()):
            FileLogger.info(f'[RTMSManager] Stopping {conn.rtms_type} {conn.rtms_id}')
            await self._on_stream_stop(stream_id)

        self._connections.clear()
        self._state = 'STOPPED'
        FileLogger.info('[RTMSManager] Stopped')

    def handle_event(self, event: str, payload: Dict[str, Any]):
        self.emit(event, payload)

    def get_active_connections(self) -> List[StreamConnection]:
        return list(self._connections.values())

    def get_active_streams(self) -> List[Dict[str, Any]]:
        return [conn.to_dict() for conn in self._connections.values()]

    def get_video_on_participants(self, stream_id: str) -> List[Dict[str, Any]]:
        conn = self._connections.get(stream_id)
        if not conn:
            return []
        return [participant.copy() for participant in conn.video_on_participants.values()]

    def get_current_video_subscription(self, stream_id: str) -> Optional[Any]:
        conn = self._connections.get(stream_id)
        if not conn:
            return None
        return conn.current_video_subscription_user_id

    async def subscribe_to_individual_video(self, stream_id: str, user_id: Any, subscribe: bool = True):
        conn = self._connections.get(stream_id)
        if not conn:
            raise RuntimeError(f'No active stream found for {stream_id}')

        if conn.signaling.get('state') != 'ready' or not conn.signaling.get('socket'):
            raise RuntimeError(f'Signaling socket is not ready for stream {stream_id}')

        if conn.config.get('media_params', {}).get('video', {}).get('data_opt') != self._config.protocol_definitions.media_data_options.VIDEO_SINGLE_INDIVIDUAL_STREAM:
            raise RuntimeError(f'Individual video subscription is not enabled for stream {stream_id}')

        await conn.signaling['socket'].send(json.dumps({
            'msg_type': self._config.protocol_definitions.message_types.VIDEO_SUBSCRIPTION_REQ,
            'user_id': user_id,
            'subscribe': subscribe,
            'timestamp': int(time.time() * 1000),
        }))

    async def request_stream_close(self, stream_id: str):
        conn = self._connections.get(stream_id)
        if not conn:
            raise RuntimeError(f'No active stream found for {stream_id}')

        if conn.signaling.get('state') != 'ready' or not conn.signaling.get('socket'):
            raise RuntimeError(f'Signaling socket is not ready for stream {stream_id}')

        await conn.signaling['socket'].send(json.dumps({
            'msg_type': self._config.protocol_definitions.message_types.STREAM_CLOSE_REQ,
            'rtms_stream_id': stream_id,
        }))

    @classmethod
    def get_stream_metadata(cls, stream_id: str) -> Optional[Dict[str, Any]]:
        if cls._instance is None:
            return None
        
        conn = cls._instance._connections.get(stream_id)
        if conn:
            return conn.to_dict()
        
        return cls._instance._stream_history.get(stream_id)

    @classmethod
    def get_stream_timestamps(cls, stream_id: str) -> Optional[Dict[str, Any]]:
        if cls._instance is None:
            return None
        
        conn = cls._instance._connections.get(stream_id)
        if conn:
            return {
                'first_packet_timestamp': conn.first_packet_timestamp,
                'last_packet_timestamp': conn.last_packet_timestamp,
            }
        
        history = cls._instance._stream_history.get(stream_id)
        return history
