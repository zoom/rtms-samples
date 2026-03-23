from dataclasses import dataclass, field
from typing import Optional, Dict, Any
from .media_params import (
    MediaType, MediaContentType, AudioSampleRate, AudioChannel,
    MediaPayloadType, MediaResolution, AudioDataOption, VideoDataOption,
    LanguageId
)
from .protocol_definitions import RTMSProtocolDefinitions, merge_protocol_definitions


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
    media_types: int = MediaType.ALL
    media_params: MediaParams = field(default_factory=MediaParams)
    logging: str = 'info'
    log_dir: Optional[str] = None
    use_unified_media_socket: bool = False
    enable_gap_filling: bool = False
    max_stream_history_size: int = 100
    reconnect_delay: int = 3000
    max_reconnect_attempts: int = 3
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
    def merge(options: Dict[str, Any]) -> RTMSConfig:
        config = RTMSConfig()
        
        if 'credentials' in options:
            creds = options['credentials']
            if 'meeting' in creds:
                m = creds['meeting']
                config.credentials.meeting = Credentials(
                    client_id=m.get('client_id', m.get('clientId', '')),
                    client_secret=m.get('client_secret', m.get('clientSecret', '')),
                    secret_token=m.get('secret_token', m.get('secretToken', m.get('zoomSecretToken', '')))
                )
            if 'video_sdk' in creds or 'videoSdk' in creds:
                v = creds.get('video_sdk', creds.get('videoSdk', {}))
                config.credentials.video_sdk = Credentials(
                    client_id=v.get('client_id', v.get('clientId', '')),
                    client_secret=v.get('client_secret', v.get('clientSecret', '')),
                    secret_token=v.get('secret_token', v.get('secretToken', ''))
                )
            if 'webinar' in creds:
                w = creds.get('webinar', {})
                config.credentials.webinar = Credentials(
                    client_id=w.get('client_id', w.get('clientId', '')),
                    client_secret=w.get('client_secret', w.get('clientSecret', '')),
                    secret_token=w.get('secret_token', w.get('secretToken', ''))
                )
            if 'contact_center' in creds or 'contactCenter' in creds:
                cc = creds.get('contact_center', creds.get('contactCenter', {}))
                config.credentials.contact_center = Credentials(
                    client_id=cc.get('client_id', cc.get('clientId', '')),
                    client_secret=cc.get('client_secret', cc.get('clientSecret', '')),
                    secret_token=cc.get('secret_token', cc.get('secretToken', ''))
                )
            if 'phone' in creds:
                p = creds.get('phone', {})
                config.credentials.phone = Credentials(
                    client_id=p.get('client_id', p.get('clientId', '')),
                    client_secret=p.get('client_secret', p.get('clientSecret', '')),
                    secret_token=p.get('secret_token', p.get('secretToken', ''))
                )
        elif 'client_id' in options or 'clientId' in options:
            shared_credentials = Credentials(
                client_id=options.get('client_id', options.get('clientId', '')),
                client_secret=options.get('client_secret', options.get('clientSecret', '')),
                secret_token=options.get('secret_token', options.get('secretToken', options.get('zoomSecretToken', '')))
            )
            config.credentials.meeting = shared_credentials
            config.credentials.webinar = Credentials(**shared_credentials.__dict__)
            config.credentials.video_sdk = Credentials(**shared_credentials.__dict__)
            config.credentials.contact_center = Credentials(**shared_credentials.__dict__)
            config.credentials.phone = Credentials(**shared_credentials.__dict__)
        
        if 'media_types' in options or 'mediaTypes' in options:
            config.media_types = options.get('media_types', options.get('mediaTypes', MediaType.ALL))
        
        if 'logging' in options:
            config.logging = options['logging']
        
        if 'log_dir' in options or 'logDir' in options:
            config.log_dir = options.get('log_dir', options.get('logDir'))
        
        if 'use_unified_media_socket' in options or 'useUnifiedMediaSocket' in options:
            config.use_unified_media_socket = options.get(
                'use_unified_media_socket', 
                options.get('useUnifiedMediaSocket', False)
            )
        elif 'media_socket_connection_mode' in options or 'mediaSocketConnectionMode' in options:
            mode = options.get('media_socket_connection_mode', options.get('mediaSocketConnectionMode', 'split'))
            if isinstance(mode, str):
                config.use_unified_media_socket = mode.lower() == 'unified'

        if 'enable_gap_filling' in options or 'enableGapFilling' in options or 'enableRealTimeAudioVideoGapFiller' in options:
            config.enable_gap_filling = options.get(
                'enable_gap_filling',
                options.get('enableGapFilling', options.get('enableRealTimeAudioVideoGapFiller', False))
            )

        protocol_definitions = options.get('protocol_definitions', options.get('protocolDefinitions'))
        if isinstance(protocol_definitions, dict):
            config.protocol_definitions = merge_protocol_definitions(protocol_definitions)

        RTMSConfigHelper._merge_media_params(config, options)
        
        return config

    @staticmethod
    def get_credentials_for_product(product: str, config: RTMSConfig) -> Credentials:
        product_map = {
            'meeting': config.credentials.meeting,
            'webinar': config.credentials.webinar or config.credentials.meeting,
            'videoSdk': config.credentials.video_sdk,
            'video_sdk': config.credentials.video_sdk,
            'contactCenter': config.credentials.contact_center or config.credentials.meeting,
            'contact_center': config.credentials.contact_center or config.credentials.meeting,
            'phone': config.credentials.phone or config.credentials.meeting,
        }
        return product_map.get(product, config.credentials.meeting)
