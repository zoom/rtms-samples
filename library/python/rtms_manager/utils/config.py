from dataclasses import dataclass, field
from typing import Optional, Dict, Any, Union
from .media_params import (
    MediaType, MediaContentType, AudioSampleRate, AudioChannel,
    MediaPayloadType, MediaResolution, AudioDataOption, VideoDataOption,
    LanguageId
)
from .protocol_definitions import RTMSProtocolDefinitions, merge_protocol_definitions
from .rtms_error import RTMSError


@dataclass
class AudioParams:
    content_type: int = MediaContentType.RAW_AUDIO
    sample_rate: int = AudioSampleRate.SR_16K
    channel: int = AudioChannel.MONO
    codec: int = MediaPayloadType.L16
    data_opt: int = AudioDataOption.MIXED_STREAM
    send_rate: int = 100


@dataclass
class VideoParams:
    content_type: int = MediaContentType.RAW_VIDEO
    codec: int = MediaPayloadType.H264
    data_opt: int = VideoDataOption.SINGLE_ACTIVE_STREAM
    resolution: int = MediaResolution.HD
    fps: int = 25


@dataclass
class DeskshareParams:
    content_type: int = MediaContentType.RAW_VIDEO
    codec: int = MediaPayloadType.JPG
    resolution: int = MediaResolution.HD
    fps: int = 1


@dataclass
class ChatParams:
    content_type: int = MediaContentType.TEXT


@dataclass
class TranscriptParams:
    content_type: int = MediaContentType.TEXT
    language: int = LanguageId.ENGLISH
    src_language: Optional[int] = None
    enable_lid: Optional[bool] = None


@dataclass
class MediaParams:
    audio: AudioParams = field(default_factory=AudioParams)
    video: VideoParams = field(default_factory=VideoParams)
    deskshare: DeskshareParams = field(default_factory=DeskshareParams)
    chat: ChatParams = field(default_factory=ChatParams)
    transcript: TranscriptParams = field(default_factory=TranscriptParams)


@dataclass
class Credentials:
    client_id: str = ""
    client_secret: str = ""
    secret_token: str = ""


@dataclass
class ProductCredentials:
    meeting: Credentials = field(default_factory=Credentials)
    video_sdk: Credentials = field(default_factory=Credentials)
    webinar: Credentials = field(default_factory=Credentials)
    contact_center: Credentials = field(default_factory=Credentials)
    phone: Credentials = field(default_factory=Credentials)
    s2s: Optional[Dict[str, str]] = None


@dataclass
class RTMSConfig:
    credentials: ProductCredentials = field(default_factory=ProductCredentials)
    media_types: int = 0
    media_params: MediaParams = field(default_factory=MediaParams)
    phone_media_params: Dict[str, Any] = field(default_factory=dict)
    logging: Union[str, Dict[str, Any]] = 'off'
    log_dir: Optional[str] = None
    enable_gap_filling: bool = False
    max_stream_history_size: int = 100
    reconnect_delay: int = 3000
    max_reconnect_attempts: int = 3
    signaling_ping_timeout_ms: int = 5000
    subscribe_all_known_events: bool = False
    async_media_events: bool = True
    max_media_event_queue_size: int = 500
    # RTMS protocol version for signaling and media handshakes. Defaults to 2;
    # set 1 for the legacy V1 protocol (Zoom Phone always uses 2 or later).
    protocol_version: int = 2
    protocol_definitions: RTMSProtocolDefinitions = field(default_factory=RTMSProtocolDefinitions)


class RTMSConfigHelper:
    @staticmethod
    def _get_option_value(data: Dict[str, Any], snake_key: str, camel_key: Optional[str] = None, default: Any = None) -> Any:
        if not isinstance(data, dict):
            return default
        if snake_key in data:
            return data[snake_key]
        if camel_key and camel_key in data:
            return data[camel_key]
        return default

    @classmethod
    def _merge_media_params(cls, config: RTMSConfig, options: Dict[str, Any]):
        media_params = options.get('media_params', options.get('mediaParams'))
        if not isinstance(media_params, dict):
            return

        audio = media_params.get('audio')
        if isinstance(audio, dict):
            config.media_params.audio.content_type = cls._get_option_value(audio, 'content_type', 'contentType', config.media_params.audio.content_type)
            config.media_params.audio.sample_rate = cls._get_option_value(audio, 'sample_rate', 'sampleRate', config.media_params.audio.sample_rate)
            config.media_params.audio.channel = cls._get_option_value(audio, 'channel', default=config.media_params.audio.channel)
            config.media_params.audio.codec = cls._get_option_value(audio, 'codec', default=config.media_params.audio.codec)
            config.media_params.audio.data_opt = cls._get_option_value(audio, 'data_opt', 'dataOpt', config.media_params.audio.data_opt)
            config.media_params.audio.send_rate = cls._get_option_value(audio, 'send_rate', 'sendRate', config.media_params.audio.send_rate)

        video = media_params.get('video')
        if isinstance(video, dict):
            config.media_params.video.content_type = cls._get_option_value(video, 'content_type', 'contentType', config.media_params.video.content_type)
            config.media_params.video.codec = cls._get_option_value(video, 'codec', default=config.media_params.video.codec)
            config.media_params.video.data_opt = cls._get_option_value(video, 'data_opt', 'dataOpt', config.media_params.video.data_opt)
            config.media_params.video.resolution = cls._get_option_value(video, 'resolution', default=config.media_params.video.resolution)
            config.media_params.video.fps = cls._get_option_value(video, 'fps', default=config.media_params.video.fps)

        deskshare = media_params.get('deskshare')
        if isinstance(deskshare, dict):
            config.media_params.deskshare.content_type = cls._get_option_value(deskshare, 'content_type', 'contentType', config.media_params.deskshare.content_type)
            config.media_params.deskshare.codec = cls._get_option_value(deskshare, 'codec', default=config.media_params.deskshare.codec)
            config.media_params.deskshare.resolution = cls._get_option_value(deskshare, 'resolution', default=config.media_params.deskshare.resolution)
            config.media_params.deskshare.fps = cls._get_option_value(deskshare, 'fps', default=config.media_params.deskshare.fps)

        chat = media_params.get('chat')
        if isinstance(chat, dict):
            config.media_params.chat.content_type = cls._get_option_value(chat, 'content_type', 'contentType', config.media_params.chat.content_type)

        transcript = media_params.get('transcript')
        if isinstance(transcript, dict):
            config.media_params.transcript.content_type = cls._get_option_value(transcript, 'content_type', 'contentType', config.media_params.transcript.content_type)
            config.media_params.transcript.language = cls._get_option_value(transcript, 'language', default=config.media_params.transcript.language)
            config.media_params.transcript.src_language = cls._get_option_value(transcript, 'src_language', 'srcLanguage', config.media_params.transcript.src_language)
            config.media_params.transcript.enable_lid = cls._get_option_value(transcript, 'enable_lid', 'enableLid', config.media_params.transcript.enable_lid)

    @staticmethod
    def _build_credentials(raw: Dict[str, Any], *, video_legacy: bool = False) -> Credentials:
        if not isinstance(raw, dict):
            return Credentials()
        client_id = raw.get('client_id', raw.get('clientId', ''))
        client_secret = raw.get('client_secret', raw.get('clientSecret', ''))
        secret_token = raw.get('secret_token', raw.get('secretToken', raw.get('zoomSecretToken', '')))
        if video_legacy:
            client_id = client_id or raw.get('video_client_id', raw.get('videoClientId', ''))
            client_secret = client_secret or raw.get('video_client_secret', raw.get('videoClientSecret', ''))
            secret_token = secret_token or raw.get('video_secret_token', raw.get('videoSecretToken', ''))
        return Credentials(
            client_id=client_id or '',
            client_secret=client_secret or '',
            secret_token=secret_token or '',
        )

    @staticmethod
    def merge(options: Dict[str, Any]) -> RTMSConfig:
        # Never mutate caller's input dictionary.
        options = dict(options or {})
        config = RTMSConfig()

        if 'credentials' in options and isinstance(options['credentials'], dict):
            creds = options['credentials']
            if 'meeting' in creds:
                config.credentials.meeting = RTMSConfigHelper._build_credentials(creds['meeting'])
            if 'video_sdk' in creds or 'videoSdk' in creds:
                v = creds.get('video_sdk', creds.get('videoSdk', {}))
                config.credentials.video_sdk = RTMSConfigHelper._build_credentials(v, video_legacy=True)
            elif 'video' in creds:
                config.credentials.video_sdk = RTMSConfigHelper._build_credentials(creds['video'], video_legacy=True)
            if 'webinar' in creds:
                config.credentials.webinar = RTMSConfigHelper._build_credentials(creds['webinar'])
            if 'contact_center' in creds or 'contactCenter' in creds:
                cc = creds.get('contact_center', creds.get('contactCenter', {}))
                config.credentials.contact_center = RTMSConfigHelper._build_credentials(cc)
            if 'phone' in creds:
                config.credentials.phone = RTMSConfigHelper._build_credentials(creds['phone'])
            if 's2s' in creds and isinstance(creds['s2s'], dict):
                config.credentials.s2s = dict(creds['s2s'])
        elif 'client_id' in options or 'clientId' in options:
            shared_credentials = RTMSConfigHelper._build_credentials(options)
            config.credentials.meeting = shared_credentials
            config.credentials.webinar = Credentials(**shared_credentials.__dict__)
            config.credentials.video_sdk = Credentials(**shared_credentials.__dict__)
            config.credentials.contact_center = Credentials(**shared_credentials.__dict__)
            config.credentials.phone = Credentials(**shared_credentials.__dict__)

        if 'media_types' in options or 'mediaTypes' in options:
            config.media_types = options.get('media_types', options.get('mediaTypes', 0))
        elif 'media_types_flag' in options or 'mediaTypesFlag' in options:
            config.media_types = options.get('media_types_flag', options.get('mediaTypesFlag', 0))

        if 'logging' in options:
            logging_opt = options['logging']
            config.logging = dict(logging_opt) if isinstance(logging_opt, dict) else logging_opt

        if 'protocol_version' in options or 'protocolVersion' in options:
            try:
                config.protocol_version = int(options.get('protocol_version', options.get('protocolVersion')))
            except (TypeError, ValueError):
                raise ValueError('protocol_version must be an integer, for example 2 (default) or 1 for legacy V1')

        if 'log_dir' in options or 'logDir' in options:
            config.log_dir = options.get('log_dir', options.get('logDir'))

        unified_requested = options.get(
            'use_unified_media_socket', options.get('useUnifiedMediaSocket', False)
        ) is True
        socket_mode = options.get(
            'media_socket_connection_mode', options.get('mediaSocketConnectionMode', '')
        )
        if unified_requested or str(socket_mode).lower() == 'unified':
            raise ValueError(
                'Unified RTMS media sockets and media type 32 are deprecated. '
                'Select explicit media_types; the library opens one split socket per media type.'
            )

        try:
            selected_media = int(config.media_types)
        except (TypeError, ValueError):
            selected_media = 0
        if selected_media <= 0 or selected_media > 31:
            raise ValueError(
                'media_types is required and must combine concrete RTMS media values: '
                'audio (1), video (2), screen share (4), transcript (8), and chat (16). '
                'The ALL value 32 is deprecated.'
            )
        config.media_types = selected_media

        if 'enable_gap_filling' in options or 'enableGapFilling' in options or 'enableRealTimeAudioVideoGapFiller' in options:
            config.enable_gap_filling = bool(options.get(
                'enable_gap_filling',
                options.get('enableGapFilling', options.get('enableRealTimeAudioVideoGapFiller', False))
            ))

        if 'max_stream_history_size' in options or 'maxStreamHistorySize' in options:
            config.max_stream_history_size = int(options.get('max_stream_history_size', options.get('maxStreamHistorySize', 100)))

        if 'reconnect_delay' in options or 'reconnectDelay' in options:
            config.reconnect_delay = int(options.get('reconnect_delay', options.get('reconnectDelay', 3000)))

        if 'max_reconnect_attempts' in options or 'maxReconnectAttempts' in options:
            config.max_reconnect_attempts = int(options.get('max_reconnect_attempts', options.get('maxReconnectAttempts', 3)))

        if 'signaling_ping_timeout_ms' in options or 'signalingPingTimeoutMs' in options:
            config.signaling_ping_timeout_ms = int(options.get('signaling_ping_timeout_ms', options.get('signalingPingTimeoutMs', 5000)))

        if 'subscribe_all_known_events' in options or 'subscribeAllKnownEvents' in options:
            config.subscribe_all_known_events = bool(options.get('subscribe_all_known_events', options.get('subscribeAllKnownEvents', False)))

        if 'async_media_events' in options or 'asyncMediaEvents' in options:
            config.async_media_events = bool(options.get('async_media_events', options.get('asyncMediaEvents', True)))

        if 'max_media_event_queue_size' in options or 'maxMediaEventQueueSize' in options:
            config.max_media_event_queue_size = int(options.get('max_media_event_queue_size', options.get('maxMediaEventQueueSize', 500)))

        phone_media_params = options.get('phone_media_params', options.get('phoneMediaParams'))
        if isinstance(phone_media_params, dict):
            config.phone_media_params = {
                k: dict(v) if isinstance(v, dict) else v
                for k, v in phone_media_params.items()
            }

        protocol_definitions = options.get('protocol_definitions', options.get('protocolDefinitions'))
        if isinstance(protocol_definitions, dict):
            config.protocol_definitions = merge_protocol_definitions(protocol_definitions)

        RTMSConfigHelper._merge_media_params(config, options)

        return config

    @staticmethod
    def get_credentials_for_product(product: str, config: RTMSConfig) -> Credentials:
        product_map = {
            'meeting': config.credentials.meeting,
            'webinar': config.credentials.webinar,
            'videoSdk': config.credentials.video_sdk,
            'video_sdk': config.credentials.video_sdk,
            'session': config.credentials.video_sdk,
            'video': config.credentials.video_sdk,
            'contactCenter': config.credentials.contact_center,
            'contact_center': config.credentials.contact_center,
            'phone': config.credentials.phone,
        }
        creds = product_map.get(product)
        if creds and creds.client_id:
            return creds

        if config.credentials.meeting and config.credentials.meeting.client_id:
            return config.credentials.meeting

        raise RTMSError.from_code(
            'MISSING_CREDENTIALS',
            message=f'[RTMSManager] No credentials found for product: {product}',
        )
