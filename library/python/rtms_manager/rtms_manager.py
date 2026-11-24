import asyncio
from collections import OrderedDict
import json
import time
from typing import Dict, Any, Callable, Optional, List
from dataclasses import dataclass, field

from .utils.logger import FileLogger
from .utils.config import RTMSConfig, RTMSConfigHelper, Credentials
from .utils.media_params import MediaType, RTMS_MEDIA_PARAMS
from .utils.rtms_entity import get_preferred_media_url, get_rtms_id_from_payload
from .utils.rtms_error import RTMSError
from .utils.redact_secrets import redact_secrets
from .utils.protocol_definitions import (
    RTMS_EVENT_CODES,
    RTMS_PROTOCOL_DEFINITIONS,
    resolve_protocol_version,
)
from .signaling_socket import connect_to_signaling_websocket
from .media_socket import connect_to_media_websocket, TYPE_FLAGS


def calculate_effective_flags(requested_flags: int, server_urls: Any) -> int:
    # V2 may return one comma-separated string that serves every media type.
    if isinstance(server_urls, str):
        return requested_flags & 31 if server_urls.strip() else 0
    effective_flags = 0
    for type_name, flag in TYPE_FLAGS.items():
        if requested_flags & flag and isinstance(server_urls, dict) and server_urls.get(type_name):
            effective_flags |= flag
    return effective_flags


def _has_changed_server_urls(previous: Any, next_urls: Any) -> bool:
    if not next_urls:
        return False
    return json.dumps(previous, sort_keys=True) != json.dumps(next_urls, sort_keys=True)


@dataclass
class StreamConnection:
    rtms_id: str
    rtms_type: str
    stream_id: str
    server_url: Any
    client_id: str
    client_secret: str
    config: Dict[str, Any]
    should_reconnect: bool = True
    signaling: Dict[str, Any] = field(default_factory=dict)
    media: Dict[str, Any] = field(default_factory=dict)
    media_config: Dict[str, Any] = field(default_factory=dict)
    media_server: Optional[Dict[str, Any]] = None
    start_time: Optional[int] = None
    first_packet_timestamp: Optional[int] = None
    last_packet_timestamp: Optional[int] = None
    ping_rtt: int = -1
    has_connected_signaling: bool = False
    signaling_status8_failures: int = 0
    video_on_participants: Dict[str, Dict[str, Any]] = field(default_factory=dict)
    current_video_subscription_user_id: Optional[Any] = None
    phone_call_info: Dict[str, Any] = field(default_factory=lambda: {'host_channel_id': None, 'participants': []})
    _signaling_connect_locked: bool = False
    _signaling_connect_ws: Optional[Any] = None
    _suppress_next_signaling_close_reconnect: Optional[Any] = None
    _signaling_reconnect_task: Optional[asyncio.Task] = None
    _duplicate_signal_retry_task: Optional[asyncio.Task] = None
    _duplicate_signal_retry_count: int = 0
    _reconnect_signaling: Optional[Callable] = None

    def get_phone_call_info(self) -> Dict[str, Any]:
        info = self.phone_call_info or {'host_channel_id': None, 'participants': []}
        return {
            'host_channel_id': info.get('host_channel_id'),
            'participants': [p.copy() for p in info.get('participants', [])],
        }

    def get_phone_participant_name(self, channel_id: Any) -> Optional[str]:
        if channel_id is None:
            return None
        target = str(channel_id)
        for participant in (self.phone_call_info or {}).get('participants', []):
            if str(participant.get('channel_id')) == target:
                return participant.get('name')
        return None

    def to_dict(self) -> Dict[str, Any]:
        return {
            'rtms_id': self.rtms_id,
            'rtms_type': self.rtms_type,
            'stream_id': self.stream_id,
            'server_url': self.server_url,
            'should_reconnect': self.should_reconnect,
            'signaling': {k: v for k, v in self.signaling.items() if k != 'socket'},
            'media': {k: {'state': v.get('state'), 'last_keep_alive': v.get('last_keep_alive')} for k, v in self.media.items()},
            'media_config': dict(self.media_config or {}),
            'start_time': self.start_time,
            'first_packet_timestamp': self.first_packet_timestamp,
            'last_packet_timestamp': self.last_packet_timestamp,
            'ping_rtt': self.ping_rtt,
            'video_on_participants': list(self.video_on_participants.values()),
            'current_video_subscription_user_id': self.current_video_subscription_user_id,
            'phone_call_info': self.get_phone_call_info(),
        }


class RTMSManager:
    _instance: Optional['RTMSManager'] = None

    MEDIA = MediaType
    MEDIA_PARAMS = RTMS_MEDIA_PARAMS
    PROTOCOL = RTMS_PROTOCOL_DEFINITIONS
    EVENT_CODES = RTMS_EVENT_CODES

    PRESETS = {
        'AUDIO_ONLY': {
            'media_types': MediaType.AUDIO,
            'media_params': {
                'audio': {
                    'content_type': RTMS_MEDIA_PARAMS['MEDIA_CONTENT_TYPE_RAW_AUDIO'],
                    'sample_rate': RTMS_MEDIA_PARAMS['AUDIO_SAMPLE_RATE_SR_16K'],
                    'channel': RTMS_MEDIA_PARAMS['AUDIO_CHANNEL_MONO'],
                    'codec': RTMS_MEDIA_PARAMS['MEDIA_PAYLOAD_TYPE_L16'],
                    'data_opt': RTMS_MEDIA_PARAMS['MEDIA_DATA_OPTION_AUDIO_MIXED_STREAM'],
                    'send_rate': 100,
                },
            },
        },
        'TRANSCRIPTION': {
            'media_types': MediaType.AUDIO | MediaType.TRANSCRIPT,
            'media_params': {
                'audio': {
                    'content_type': RTMS_MEDIA_PARAMS['MEDIA_CONTENT_TYPE_RAW_AUDIO'],
                    'sample_rate': RTMS_MEDIA_PARAMS['AUDIO_SAMPLE_RATE_SR_16K'],
                    'channel': RTMS_MEDIA_PARAMS['AUDIO_CHANNEL_MONO'],
                    'codec': RTMS_MEDIA_PARAMS['MEDIA_PAYLOAD_TYPE_L16'],
                    'data_opt': RTMS_MEDIA_PARAMS['MEDIA_DATA_OPTION_AUDIO_MIXED_STREAM'],
                    'send_rate': 100,
                },
                'transcript': {
                    'content_type': RTMS_MEDIA_PARAMS['MEDIA_CONTENT_TYPE_TEXT'],
                    'language': RTMS_MEDIA_PARAMS['LANGUAGE_ID_ENGLISH'],
                },
            },
        },
        'VIDEO_RECORDING': {
            'media_types': MediaType.AUDIO | MediaType.VIDEO,
            'media_params': {
                'audio': {
                    'content_type': RTMS_MEDIA_PARAMS['MEDIA_CONTENT_TYPE_RAW_AUDIO'],
                    'sample_rate': RTMS_MEDIA_PARAMS['AUDIO_SAMPLE_RATE_SR_16K'],
                    'channel': RTMS_MEDIA_PARAMS['AUDIO_CHANNEL_MONO'],
                    'codec': RTMS_MEDIA_PARAMS['MEDIA_PAYLOAD_TYPE_L16'],
                    'data_opt': RTMS_MEDIA_PARAMS['MEDIA_DATA_OPTION_AUDIO_MIXED_STREAM'],
                    'send_rate': 100,
                },
                'video': {
                    'content_type': RTMS_MEDIA_PARAMS['MEDIA_CONTENT_TYPE_RAW_VIDEO'],
                    'codec': RTMS_MEDIA_PARAMS['MEDIA_PAYLOAD_TYPE_H264'],
                    'data_opt': RTMS_MEDIA_PARAMS['MEDIA_DATA_OPTION_VIDEO_SINGLE_ACTIVE_STREAM'],
                    'resolution': RTMS_MEDIA_PARAMS['MEDIA_RESOLUTION_HD'],
                    'fps': 25,
                },
            },
        },
        # Zoom Phone: per-channel call audio and transcript over RTMS protocol V2.
        # Phone media handshakes omit meeting-style media_params unless overridden.
        'PHONE': {
            'media_types': MediaType.AUDIO | MediaType.TRANSCRIPT,
            'protocol_version': 2,
        },
    }

    redact_secrets = staticmethod(redact_secrets)

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
        self._stream_history: 'OrderedDict[str, Dict[str, Any]]' = OrderedDict()
        self._event_handlers: Dict[str, List[Callable]] = {}
        self._stop_task: Optional[asyncio.Task] = None
        self._initialized = True

    @classmethod
    def reset(cls):
        """Reset singleton state (intended for tests)."""
        cls._instance = None

    @classmethod
    async def init(cls, options: Dict[str, Any] = None) -> 'RTMSManager':
        if cls._instance and cls._instance._initialized:
            FileLogger.warn('[RTMSManager] Already initialized. Returning existing instance.')
            return cls._instance

        options = options or {}
        config = RTMSConfigHelper.merge(options)

        if config.log_dir:
            FileLogger.set_log_dir(config.log_dir)
        if isinstance(config.logging, dict):
            log_dir = config.logging.get('log_dir', config.logging.get('logDir'))
            if log_dir:
                FileLogger.set_log_dir(log_dir)
            if isinstance(config.logging.get('console'), bool):
                FileLogger.set_console_output(config.logging['console'])
            if isinstance(config.logging.get('file'), bool):
                FileLogger.set_file_output(config.logging['file'])
            effective_level = 'off' if config.logging.get('enabled') is False else (config.logging.get('level') or 'info')
            FileLogger.set_level(effective_level)
        elif config.logging and config.logging != 'off':
            FileLogger.set_level(config.logging)
        elif not options.get('logger'):
            FileLogger.set_level('off')

        if options.get('logger'):
            FileLogger.add_sink('rtms-manager-custom-logger', options['logger'])

        instance = cls(config)
        await instance.start()
        return instance

    @classmethod
    def instance(cls) -> 'RTMSManager':
        if cls._instance is None or not cls._instance._initialized:
            raise RTMSError.from_code('NOT_INITIALIZED')
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
            for handler in list(self._event_handlers[event]):
                try:
                    result = handler(*args, **kwargs)
                    if asyncio.iscoroutine(result):
                        asyncio.create_task(result)
                except Exception as e:
                    FileLogger.error(f'[RTMSManager] Event handler error for {event}: {e}')
        elif event == 'error' and args:
            err = args[0]
            text = err.to_short_string() if hasattr(err, 'to_short_string') else str(err)
            FileLogger.error(f'[RTMSManager] {text}')

    async def start(self):
        if self._state == 'STARTED':
            FileLogger.warn('[RTMSManager] Manager already started.')
            return
        if self._state not in ('INITIALIZED', 'STOPPED'):
            raise RTMSError.from_code('INVALID_CONFIG', message=f'Cannot start from state: {self._state}')

        self._state = 'STARTED'
        self._stop_task = None

        if not self._event_handlers.get('meeting.rtms_started'):
            self._setup_internal_handlers()

        FileLogger.info('[RTMSManager] Ready - feed RTMS events via emit(event, payload)')

    def _setup_internal_handlers(self):
        self.on('meeting.rtms_started', self._on_meeting_started)
        self.on('meeting.rtms_stopped', self._on_meeting_stopped)
        self.on('meeting.rtms_interrupted', self._on_interrupted_webhook)
        self.on('session.rtms_started', self._on_session_started)
        self.on('session.rtms_stopped', self._on_session_stopped)
        self.on('session.rtms_interrupted', self._on_interrupted_webhook)
        self.on('webinar.rtms_started', self._on_webinar_started)
        self.on('webinar.rtms_stopped', self._on_webinar_stopped)
        self.on('webinar.rtms_interrupted', self._on_interrupted_webhook)
        self.on('contact_center.voice_rtms_started', self._on_contact_center_started)
        self.on('contact_center.voice_rtms_stopped', self._on_contact_center_stopped)
        self.on('contact_center.voice_rtms_interrupted', self._on_interrupted_webhook)
        # Zoom Phone webhooks are phone.call_rtms_*; phone.rtms_* is kept as an alias.
        self.on('phone.call_rtms_started', self._on_phone_started)
        self.on('phone.rtms_started', self._on_phone_started)
        self.on('phone.call_rtms_stopped', self._on_phone_stopped)
        self.on('phone.rtms_stopped', self._on_phone_stopped)
        self.on('phone.call_rtms_interrupted', self._on_interrupted_webhook)
        self.on('phone.rtms_interrupted', self._on_interrupted_webhook)
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
        asyncio.create_task(self._on_stream_stop(payload.get('rtms_stream_id')))

    def _on_session_started(self, payload: Dict[str, Any]):
        session_id = payload.get('session_id')
        stream_id = payload.get('rtms_stream_id')
        server_urls = payload.get('server_urls')
        event_ts = payload.get('event_ts')
        creds = RTMSConfigHelper.get_credentials_for_product('video_sdk', self._config)
        asyncio.create_task(self._on_stream_start(session_id, 'video_sdk', stream_id, server_urls, creds, event_ts))

    def _on_session_stopped(self, payload: Dict[str, Any]):
        asyncio.create_task(self._on_stream_stop(payload.get('rtms_stream_id')))

    def _on_webinar_started(self, payload: Dict[str, Any]):
        webinar_uuid = payload.get('webinar_uuid')
        stream_id = payload.get('rtms_stream_id')
        server_urls = payload.get('server_urls')
        event_ts = payload.get('event_ts')
        creds = RTMSConfigHelper.get_credentials_for_product('webinar', self._config)
        asyncio.create_task(self._on_stream_start(webinar_uuid, 'webinar', stream_id, server_urls, creds, event_ts))

    def _on_webinar_stopped(self, payload: Dict[str, Any]):
        asyncio.create_task(self._on_stream_stop(payload.get('rtms_stream_id')))

    def _on_contact_center_started(self, payload: Dict[str, Any]):
        engagement_id = get_rtms_id_from_payload('contact_center', payload)
        stream_id = payload.get('rtms_stream_id')
        server_urls = payload.get('server_urls')
        event_ts = payload.get('event_ts')
        creds = RTMSConfigHelper.get_credentials_for_product('contact_center', self._config)
        asyncio.create_task(self._on_stream_start(engagement_id, 'contact_center', stream_id, server_urls, creds, event_ts))

    def _on_contact_center_stopped(self, payload: Dict[str, Any]):
        asyncio.create_task(self._on_stream_stop(payload.get('rtms_stream_id')))

    def _on_phone_started(self, payload: Dict[str, Any]):
        call_id = get_rtms_id_from_payload('phone', payload)
        stream_id = payload.get('rtms_stream_id')
        server_urls = payload.get('server_urls')
        event_ts = payload.get('event_ts')
        creds = RTMSConfigHelper.get_credentials_for_product('phone', self._config)
        # Repeated Phone start signals RTMS server failover even with unchanged URLs.
        asyncio.create_task(
            self._on_stream_start(call_id, 'phone', stream_id, server_urls, creds, event_ts, restart_if_active=True)
        )

    def _on_phone_stopped(self, payload: Dict[str, Any]):
        asyncio.create_task(self._on_stream_stop(payload.get('rtms_stream_id')))

    def _on_interrupted_webhook(self, payload: Dict[str, Any]):
        stream_id = payload.get('rtms_stream_id')
        asyncio.create_task(self._on_stream_interrupted(stream_id))

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
        server_url: Any,
        creds: Credentials,
        start_time: Optional[int] = None,
        restart_if_active: bool = False,
    ):
        if self._state != 'STARTED':
            FileLogger.warn(f'[RTMSManager] Ignoring {rtms_type} stream {stream_id} while manager state is {self._state}')
            return

        existing_conn = self._find_connection_by_rtms_id(rtms_id)
        if existing_conn:
            if existing_conn.stream_id == stream_id:
                if restart_if_active or _has_changed_server_urls(existing_conn.server_url, server_url):
                    FileLogger.warn(
                        f'[RTMSManager] Refreshing {rtms_type} {rtms_id} stream {stream_id} after a repeated start (server failover or new signaling URLs)'
                    )
                    await self._on_stream_stop(stream_id)
                else:
                    FileLogger.warn(f'[RTMSManager] Duplicate stream ID {stream_id} for {rtms_type} {rtms_id}')
                    return
            else:
                FileLogger.warn(
                    f'[RTMSManager] Replacing stale {existing_conn.rtms_type} {rtms_id} stream {existing_conn.stream_id} with new stream {stream_id}'
                )
                await self._on_stream_stop(existing_conn.stream_id)

        if self._state != 'STARTED':
            FileLogger.warn(f'[RTMSManager] Stream {stream_id} was closed while manager shutdown was in progress')
            return

        if stream_id in self._connections:
            FileLogger.warn(f'[RTMSManager] Duplicate stream ID {stream_id} for {rtms_type} {rtms_id}')
            return

        FileLogger.info(f'[RTMSManager] Starting {rtms_type} {rtms_id} stream {stream_id}')

        transcript_params: Dict[str, Any] = {
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
                'phone_media_params': self._config.phone_media_params,
                'media_types_flag': self._config.media_types,
                'protocol_definitions': self._config.protocol_definitions.to_dict(),
                'protocol_version': resolve_protocol_version(rtms_type, self._config.protocol_version),
                'reconnect_delay': self._config.reconnect_delay,
                'signaling_ping_timeout_ms': self._config.signaling_ping_timeout_ms,
                'subscribe_all_known_events': self._config.subscribe_all_known_events,
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

            for type_name, flag in TYPE_FLAGS.items():
                if effective_flags & flag:
                    type_url = get_preferred_media_url(rtms_type, media_server.get('server_urls', {}), type_name)
                    if not type_url:
                        FileLogger.warn(
                            f'[RTMSManager] No media URL returned for requested type {type_name}'
                        )
                        continue
                    await connect_to_media_websocket(
                        type_url, rtms_id, stream_id, conn_state,
                        creds.client_id, creds.client_secret,
                        type_name, flag, self.emit
                    )

        async def reconnect_signaling():
            if conn.should_reconnect:
                await connect_to_signaling_websocket(
                    rtms_id, stream_id, conn.server_url, conn_state,
                    creds.client_id, creds.client_secret,
                    self.emit, self._config.media_types, on_media_url_received
                )

        conn._reconnect_signaling = reconnect_signaling

        await connect_to_signaling_websocket(
            rtms_id, stream_id, server_url, conn_state,
            creds.client_id, creds.client_secret,
            self.emit, self._config.media_types, on_media_url_received
        )

    async def _on_stream_interrupted(self, stream_id: str) -> bool:
        return await self.reconnect_stream(stream_id)

    async def reconnect_stream(self, stream_id: str, server_urls: Any = None) -> bool:
        conn = self._connections.get(stream_id)
        if not conn:
            FileLogger.warn(f'[RTMSManager] Ignoring interrupted/reconnect for unknown streamId {stream_id}')
            return False

        FileLogger.warn(f'[RTMSManager] Reconnecting interrupted {conn.rtms_type} {conn.rtms_id} stream {stream_id}')
        if server_urls:
            conn.server_url = server_urls

        if conn._signaling_reconnect_task:
            conn._signaling_reconnect_task.cancel()
            conn._signaling_reconnect_task = None
        if conn._duplicate_signal_retry_task:
            conn._duplicate_signal_retry_task.cancel()
            conn._duplicate_signal_retry_task = None

        conn.should_reconnect = False
        conn.last_packet_timestamp = int(time.time() * 1000)

        for media_obj in (conn.media or {}).values():
            if isinstance(media_obj, dict):
                if media_obj.get('reconnect_task'):
                    media_obj['reconnect_task'].cancel()
                    media_obj['reconnect_task'] = None
                if media_obj.get('socket'):
                    try:
                        await media_obj['socket'].close()
                    except Exception:
                        pass

        sig_ws = conn.signaling.get('socket')
        if sig_ws:
            conn._suppress_next_signaling_close_reconnect = sig_ws
            try:
                await sig_ws.close()
            except Exception:
                pass
            conn.signaling['socket'] = None

        conn._signaling_connect_locked = False
        conn._signaling_connect_ws = None
        conn.should_reconnect = True

        if callable(conn._reconnect_signaling):
            await conn._reconnect_signaling()
        return True

    async def _on_stream_stop(self, stream_id: str):
        conn = self._connections.get(stream_id)
        if not conn:
            if stream_id in self._stream_history:
                FileLogger.log(f'[RTMSManager] Stream {stream_id} was already stopped and archived')
                return
            FileLogger.warn(f'[RTMSManager] No handler found for streamId {stream_id}')
            return

        FileLogger.info(f'[RTMSManager] Stopping {conn.rtms_type} {conn.rtms_id} stream {stream_id}')

        conn.should_reconnect = False
        now_ms = int(time.time() * 1000)
        if conn.last_packet_timestamp is None:
            conn.last_packet_timestamp = now_ms

        if getattr(conn, '_signaling_reconnect_task', None):
            conn._signaling_reconnect_task.cancel()
            conn._signaling_reconnect_task = None
        if getattr(conn, '_duplicate_signal_retry_task', None):
            conn._duplicate_signal_retry_task.cancel()
            conn._duplicate_signal_retry_task = None
        conn._signaling_connect_locked = False
        conn._signaling_connect_ws = None
        conn._suppress_next_signaling_close_reconnect = conn.signaling.get('socket')

        close_coros = []
        if conn.signaling.get('socket'):
            close_coros.append(self._close_with_timeout(conn.signaling['socket']))

        for media_obj in conn.media.values():
            if isinstance(media_obj, dict):
                if media_obj.get('reconnect_task'):
                    media_obj['reconnect_task'].cancel()
                    media_obj['reconnect_task'] = None
                if media_obj.get('socket'):
                    close_coros.append(self._close_with_timeout(media_obj['socket']))

        if close_coros:
            await asyncio.gather(*close_coros, return_exceptions=True)

        self._archive_stream_instance(stream_id, {
            'rtms_id': conn.rtms_id,
            'rtms_type': conn.rtms_type,
            'stream_id': conn.stream_id,
            'server_url': conn.server_url,
            'client_id': conn.client_id,
            'start_time': conn.start_time,
            'end_time': now_ms,
            'first_packet_timestamp': conn.first_packet_timestamp,
            'last_packet_timestamp': conn.last_packet_timestamp,
            'ping_rtt': conn.ping_rtt,
            'media_config': dict(conn.media_config or {}),
            'video_on_participants': list(conn.video_on_participants.values()),
            'current_video_subscription_user_id': conn.current_video_subscription_user_id,
            'phone_call_info': conn.get_phone_call_info(),
        })

        self._connections.pop(stream_id, None)

    @staticmethod
    async def _close_with_timeout(socket: Any, timeout_sec: float = 2.0):
        try:
            res = socket.close()
            if asyncio.iscoroutine(res):
                await asyncio.wait_for(res, timeout=timeout_sec)
        except Exception:
            pass

    def _archive_stream_instance(self, stream_id: str, data: Dict[str, Any]):
        max_size = max(1, int(self._config.max_stream_history_size or 100))
        entry = dict(data)
        entry['archived_at'] = int(time.time() * 1000)
        if stream_id in self._stream_history:
            self._stream_history.move_to_end(stream_id)
        self._stream_history[stream_id] = entry
        while len(self._stream_history) > max_size:
            evicted_id, _ = self._stream_history.popitem(last=False)
            FileLogger.log(f'[RTMSManager] Evicted stream {evicted_id} from history (LRU)')

    @classmethod
    def archive_stream(cls, stream_id: str, data: Dict[str, Any]):
        if cls._instance is None:
            return
        cls._instance._archive_stream_instance(stream_id, data)

    async def stop(self):
        if self._state == 'STOPPING' and self._stop_task:
            return await self._stop_task
        if self._state != 'STARTED':
            FileLogger.warn('[RTMSManager] Manager not started.')
            return

        self._state = 'STOPPING'

        async def _do_stop():
            stream_ids = list(self._connections.keys())
            if stream_ids:
                await asyncio.gather(
                    *(self._on_stream_stop(sid) for sid in stream_ids),
                    return_exceptions=True,
                )
            self._connections.clear()
            self._state = 'STOPPED'
            FileLogger.info('[RTMSManager] Stopped')

        self._stop_task = asyncio.create_task(_do_stop())
        return await self._stop_task

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

    def get_phone_call_info(self, stream_id: str) -> Optional[Dict[str, Any]]:
        conn = self._connections.get(stream_id)
        if conn:
            return conn.get_phone_call_info()
        history = self._stream_history.get(stream_id)
        if history and 'phone_call_info' in history:
            return history['phone_call_info']
        return None

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
        if not history:
            return None
        return {
            'first_packet_timestamp': history.get('first_packet_timestamp'),
            'last_packet_timestamp': history.get('last_packet_timestamp'),
        }

    @classmethod
    def get_stream_start_time(cls, stream_id: str) -> Optional[int]:
        if cls._instance is None:
            return None
        conn = cls._instance._connections.get(stream_id)
        if conn:
            return conn.start_time
        history = cls._instance._stream_history.get(stream_id)
        return history.get('start_time') if history else None

    @classmethod
    def get_stream_media_config(cls, stream_id: str) -> Optional[Dict[str, Any]]:
        if cls._instance is None:
            return None
        conn = cls._instance._connections.get(stream_id)
        if conn:
            return conn.media_config
        history = cls._instance._stream_history.get(stream_id)
        return history.get('media_config') if history else None

    @classmethod
    def get_audio_details(cls, stream_id: str) -> Optional[Dict[str, Any]]:
        cfg = cls.get_stream_media_config(stream_id)
        return cfg.get('audio') if isinstance(cfg, dict) else None

    @classmethod
    def get_video_details(cls, stream_id: str) -> Optional[Dict[str, Any]]:
        cfg = cls.get_stream_media_config(stream_id)
        return cfg.get('video') if isinstance(cfg, dict) else None

    @classmethod
    def get_sharescreen_details(cls, stream_id: str) -> Optional[Dict[str, Any]]:
        cfg = cls.get_stream_media_config(stream_id)
        return cfg.get('deskshare') if isinstance(cfg, dict) else None

    @classmethod
    def get_transcript_details(cls, stream_id: str) -> Optional[Dict[str, Any]]:
        cfg = cls.get_stream_media_config(stream_id)
        return cfg.get('transcript') if isinstance(cfg, dict) else None

    @classmethod
    def get_chat_details(cls, stream_id: str) -> Optional[Dict[str, Any]]:
        cfg = cls.get_stream_media_config(stream_id)
        return cfg.get('chat') if isinstance(cfg, dict) else None

    @classmethod
    def get_ping_rtt(cls, stream_id: str) -> int:
        metadata = cls.get_stream_metadata(stream_id)
        return metadata.get('ping_rtt', -1) if isinstance(metadata, dict) else -1
