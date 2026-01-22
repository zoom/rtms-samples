"""
RTMS Media Parameters Constants
Equivalent to JavaScript rtmsMediaParams.js
"""
from enum import IntEnum, IntFlag


class MediaContentType(IntEnum):
    """Media content type constants"""
    RAW = 0
    RTP = 1
    TEXT = 5


class AudioSampleRate(IntEnum):
    """Audio sample rate constants"""
    SR_8K = 0
    SR_16K = 1
    SR_24K = 2
    SR_32K = 3
    SR_48K = 4


class AudioChannel(IntEnum):
    """Audio channel constants"""
    MONO = 1
    STEREO = 2


class MediaPayloadType(IntEnum):
    """Media payload/codec type constants"""
    L16 = 1      # PCM 16-bit
    OPUS = 2
    H264 = 7
    JPG = 5
    PNG = 6
    VP8 = 8


class MediaResolution(IntEnum):
    """Video resolution constants"""
    SD = 1    # 640x360
    HD = 2    # 1280x720
    FHD = 3   # 1920x1080


class AudioDataOption(IntEnum):
    """Audio data option constants"""
    MIXED_STREAM = 1          # Single mixed audio stream
    INDIVIDUAL_STREAMS = 2    # Separate stream per participant


class VideoDataOption(IntEnum):
    """Video data option constants"""
    SINGLE_ACTIVE_STREAM = 3  # Active speaker only
    ALL_STREAMS = 4           # All participant streams


class LanguageId(IntEnum):
    """Language ID constants for transcripts"""
    ENGLISH = 0
    CHINESE_SIMPLIFIED = 1
    JAPANESE = 2
    GERMAN = 3
    FRENCH = 4
    RUSSIAN = 5
    PORTUGUESE = 6
    SPANISH = 7
    KOREAN = 8
    ITALIAN = 9
    VIETNAMESE = 10
    POLISH = 11
    DUTCH = 12
    TURKISH = 13
    INDONESIAN = 14
    HEBREW = 15
    MALAY = 16
    CZECH = 17
    HUNGARIAN = 18
    HINDI = 19
    THAI = 20
    UKRAINIAN = 21
    ARABIC = 22
    GREEK = 23
    ROMANIAN = 24
    SLOVAK = 25
    DANISH = 26
    FINNISH = 27
    SWEDISH = 28
    NORWEGIAN = 29
    TAGALOG = 30
    BENGALI = 31
    TAMIL = 32
    TELUGU = 33
    CHINESE_TRADITIONAL = 34


class MediaType(IntFlag):
    """Media type flags for subscription"""
    AUDIO = 1
    VIDEO = 2
    SHARESCREEN = 4
    TRANSCRIPT = 8
    CHAT = 16
    ALL = 32


# Flat constants dict for backward compatibility
RTMS_MEDIA_PARAMS = {
    # Content types
    'MEDIA_CONTENT_TYPE_RAW': MediaContentType.RAW,
    'MEDIA_CONTENT_TYPE_RTP': MediaContentType.RTP,
    'MEDIA_CONTENT_TYPE_TEXT': MediaContentType.TEXT,
    
    # Sample rates
    'AUDIO_SAMPLE_RATE_SR_8K': AudioSampleRate.SR_8K,
    'AUDIO_SAMPLE_RATE_SR_16K': AudioSampleRate.SR_16K,
    'AUDIO_SAMPLE_RATE_SR_24K': AudioSampleRate.SR_24K,
    'AUDIO_SAMPLE_RATE_SR_32K': AudioSampleRate.SR_32K,
    'AUDIO_SAMPLE_RATE_SR_48K': AudioSampleRate.SR_48K,
    
    # Channels
    'AUDIO_CHANNEL_MONO': AudioChannel.MONO,
    'AUDIO_CHANNEL_STEREO': AudioChannel.STEREO,
    
    # Codecs
    'MEDIA_PAYLOAD_TYPE_L16': MediaPayloadType.L16,
    'MEDIA_PAYLOAD_TYPE_OPUS': MediaPayloadType.OPUS,
    'MEDIA_PAYLOAD_TYPE_H264': MediaPayloadType.H264,
    'MEDIA_PAYLOAD_TYPE_JPG': MediaPayloadType.JPG,
    'MEDIA_PAYLOAD_TYPE_PNG': MediaPayloadType.PNG,
    'MEDIA_PAYLOAD_TYPE_VP8': MediaPayloadType.VP8,
    
    # Resolutions
    'MEDIA_RESOLUTION_SD': MediaResolution.SD,
    'MEDIA_RESOLUTION_HD': MediaResolution.HD,
    'MEDIA_RESOLUTION_FHD': MediaResolution.FHD,
    
    # Data options
    'MEDIA_DATA_OPTION_AUDIO_MIXED_STREAM': AudioDataOption.MIXED_STREAM,
    'MEDIA_DATA_OPTION_AUDIO_INDIVIDUAL_STREAMS': AudioDataOption.INDIVIDUAL_STREAMS,
    'MEDIA_DATA_OPTION_VIDEO_SINGLE_ACTIVE_STREAM': VideoDataOption.SINGLE_ACTIVE_STREAM,
    'MEDIA_DATA_OPTION_VIDEO_ALL_STREAMS': VideoDataOption.ALL_STREAMS,
    
    # Media types
    'MEDIA_DATA_TYPE_AUDIO': MediaType.AUDIO,
    'MEDIA_DATA_TYPE_VIDEO': MediaType.VIDEO,
    'MEDIA_DATA_TYPE_SHARESCREEN': MediaType.SHARESCREEN,
    'MEDIA_DATA_TYPE_TRANSCRIPT': MediaType.TRANSCRIPT,
    'MEDIA_DATA_TYPE_CHAT': MediaType.CHAT,
    'MEDIA_DATA_TYPE_ALL': MediaType.ALL,
    
    # Languages
    'LANGUAGE_ID_ENGLISH': LanguageId.ENGLISH,
    'LANGUAGE_ID_CHINESE_SIMPLIFIED': LanguageId.CHINESE_SIMPLIFIED,
    'LANGUAGE_ID_JAPANESE': LanguageId.JAPANESE,
    'LANGUAGE_ID_GERMAN': LanguageId.GERMAN,
    'LANGUAGE_ID_FRENCH': LanguageId.FRENCH,
    'LANGUAGE_ID_SPANISH': LanguageId.SPANISH,
}
