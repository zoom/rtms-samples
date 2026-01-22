from dataclasses import dataclass, field
from typing import Optional, Dict, Any
from .media_params import (
    MediaType, MediaContentType, AudioSampleRate, AudioChannel,
    MediaPayloadType, MediaResolution, AudioDataOption, VideoDataOption,
    LanguageId
)


@dataclass
class AudioParams:
    content_type: int = MediaContentType.RTP
    sample_rate: int = AudioSampleRate.SR_16K
    channel: int = AudioChannel.MONO
    codec: int = MediaPayloadType.L16
    data_opt: int = AudioDataOption.MIXED_STREAM
    send_rate: int = 100


@dataclass
class VideoParams:
    codec: int = MediaPayloadType.H264
    data_opt: int = VideoDataOption.SINGLE_ACTIVE_STREAM
    resolution: int = MediaResolution.HD
    fps: int = 25


@dataclass
class DeskshareParams:
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


class RTMSConfigHelper:
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
        elif 'client_id' in options or 'clientId' in options:
            config.credentials.meeting = Credentials(
                client_id=options.get('client_id', options.get('clientId', '')),
                client_secret=options.get('client_secret', options.get('clientSecret', '')),
                secret_token=options.get('secret_token', options.get('secretToken', options.get('zoomSecretToken', '')))
            )
        
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
        
        if 'enable_gap_filling' in options or 'enableGapFilling' in options or 'enableRealTimeAudioVideoGapFiller' in options:
            config.enable_gap_filling = options.get(
                'enable_gap_filling',
                options.get('enableGapFilling', options.get('enableRealTimeAudioVideoGapFiller', False))
            )
        
        return config

    @staticmethod
    def get_credentials_for_product(product: str, config: RTMSConfig) -> Credentials:
        product_map = {
            'meeting': config.credentials.meeting,
            'webinar': config.credentials.webinar or config.credentials.meeting,
            'videoSdk': config.credentials.video_sdk,
            'video_sdk': config.credentials.video_sdk,
            'contactCenter': config.credentials.meeting,
            'phone': config.credentials.meeting,
        }
        return product_map.get(product, config.credentials.meeting)
