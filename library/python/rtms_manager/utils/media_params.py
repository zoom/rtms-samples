"""
RTMS media parameter constants.

Kept in parity with the JavaScript RTMS library in this repo.
"""
from enum import IntEnum, IntFlag


class MediaContentType(IntEnum):
    RAW_AUDIO = 2
    RAW_VIDEO = 3
    FILE_STREAM = 4
    TEXT = 5
    RTP = RAW_AUDIO  # Deprecated alias for backward compatibility
    RAW = RAW_AUDIO  # Deprecated alias for backward compatibility


class AudioSampleRate(IntEnum):
    SR_8K = 0
    SR_16K = 1
    SR_32K = 2
    SR_48K = 3


class AudioChannel(IntEnum):
    MONO = 1
    STEREO = 2


class MediaPayloadType(IntEnum):
    L16 = 1
    G711 = 2
    G722 = 3
    OPUS = 4
    JPG = 5
    PNG = 6
    H264 = 7


class MediaResolution(IntEnum):
    SD = 1
    HD = 2
    FHD = 3
    QHD = 4


class AudioDataOption(IntEnum):
    MIXED_STREAM = 1
    INDIVIDUAL_STREAMS = 2


class VideoDataOption(IntEnum):
    SINGLE_ACTIVE_STREAM = 3
    SINGLE_INDIVIDUAL_STREAM = 4
    MIXED_SPEAKER_VIEW = SINGLE_ACTIVE_STREAM  # Deprecated alias retained for compatibility
    MIXED_GALLERY_VIEW = SINGLE_ACTIVE_STREAM  # Deprecated alias retained for compatibility
    ALL_STREAMS = SINGLE_ACTIVE_STREAM  # Deprecated alias retained for compatibility


class LanguageId(IntEnum):
    NONE = -1
    ARABIC = 0
    BENGALI = 1
    CANTONESE = 2
    CATALAN = 3
    CHINESE_SIMPLIFIED = 4
    CHINESE_TRADITIONAL = 5
    CZECH = 6
    DANISH = 7
    DUTCH = 8
    ENGLISH = 9
    ESTONIAN = 10
    FINNISH = 11
    FRENCH_CANADA = 12
    FRENCH_FRANCE = 13
    GERMAN = 14
    HEBREW = 15
    HINDI = 16
    HUNGARIAN = 17
    INDONESIAN = 18
    ITALIAN = 19
    JAPANESE = 20
    KOREAN = 21
    MALAY = 22
    PERSIAN = 23
    POLISH = 24
    PORTUGUESE = 25
    ROMANIAN = 26
    RUSSIAN = 27
    SPANISH = 28
    SWEDISH = 29
    TAGALOG = 30
    TAMIL = 31
    TELUGU = 32
    THAI = 33
    TURKISH = 34
    UKRAINIAN = 35
    VIETNAMESE = 36


class MediaType(IntFlag):
    AUDIO = 1
    VIDEO = 2
    SHARESCREEN = 4
    TRANSCRIPT = 8
    CHAT = 16
    ALL = 32


RTMS_MEDIA_PARAMS = {
    'MEDIA_CONTENT_TYPE_RAW': MediaContentType.RAW,
    'MEDIA_CONTENT_TYPE_RAW_AUDIO': MediaContentType.RAW_AUDIO,
    'MEDIA_CONTENT_TYPE_RAW_VIDEO': MediaContentType.RAW_VIDEO,
    'MEDIA_CONTENT_TYPE_FILE_STREAM': MediaContentType.FILE_STREAM,
    'MEDIA_CONTENT_TYPE_RTP': MediaContentType.RTP,
    'MEDIA_CONTENT_TYPE_TEXT': MediaContentType.TEXT,

    'AUDIO_SAMPLE_RATE_SR_8K': AudioSampleRate.SR_8K,
    'AUDIO_SAMPLE_RATE_SR_16K': AudioSampleRate.SR_16K,
    'AUDIO_SAMPLE_RATE_SR_32K': AudioSampleRate.SR_32K,
    'AUDIO_SAMPLE_RATE_SR_48K': AudioSampleRate.SR_48K,

    'AUDIO_CHANNEL_MONO': AudioChannel.MONO,
    'AUDIO_CHANNEL_STEREO': AudioChannel.STEREO,

    'MEDIA_PAYLOAD_TYPE_L16': MediaPayloadType.L16,
    'MEDIA_PAYLOAD_TYPE_G711': MediaPayloadType.G711,
    'MEDIA_PAYLOAD_TYPE_G722': MediaPayloadType.G722,
    'MEDIA_PAYLOAD_TYPE_OPUS': MediaPayloadType.OPUS,
    'MEDIA_PAYLOAD_TYPE_JPG': MediaPayloadType.JPG,
    'MEDIA_PAYLOAD_TYPE_PNG': MediaPayloadType.PNG,
    'MEDIA_PAYLOAD_TYPE_H264': MediaPayloadType.H264,

    'MEDIA_RESOLUTION_SD': MediaResolution.SD,
    'MEDIA_RESOLUTION_HD': MediaResolution.HD,
    'MEDIA_RESOLUTION_FHD': MediaResolution.FHD,
    'MEDIA_RESOLUTION_QHD': MediaResolution.QHD,

    'MEDIA_DATA_OPTION_AUDIO_MIXED_STREAM': AudioDataOption.MIXED_STREAM,
    'MEDIA_DATA_OPTION_AUDIO_INDIVIDUAL_STREAMS': AudioDataOption.INDIVIDUAL_STREAMS,
    'MEDIA_DATA_OPTION_VIDEO_SINGLE_ACTIVE_STREAM': VideoDataOption.SINGLE_ACTIVE_STREAM,
    'MEDIA_DATA_OPTION_VIDEO_MIXED_SPEAKER_VIEW': VideoDataOption.MIXED_SPEAKER_VIEW,
    'MEDIA_DATA_OPTION_VIDEO_MIXED_GALLERY_VIEW': VideoDataOption.MIXED_GALLERY_VIEW,
    'MEDIA_DATA_OPTION_VIDEO_SINGLE_INDIVIDUAL_STREAM': VideoDataOption.SINGLE_INDIVIDUAL_STREAM,
    'MEDIA_DATA_OPTION_VIDEO_ALL_STREAMS': VideoDataOption.ALL_STREAMS,

    'MEDIA_DATA_TYPE_AUDIO': MediaType.AUDIO,
    'MEDIA_DATA_TYPE_VIDEO': MediaType.VIDEO,
    'MEDIA_DATA_TYPE_SHARESCREEN': MediaType.SHARESCREEN,
    'MEDIA_DATA_TYPE_TRANSCRIPT': MediaType.TRANSCRIPT,
    'MEDIA_DATA_TYPE_CHAT': MediaType.CHAT,
    'MEDIA_DATA_TYPE_ALL': MediaType.ALL,

    'LANGUAGE_ID_NONE': LanguageId.NONE,
    'LANGUAGE_ID_ARABIC': LanguageId.ARABIC,
    'LANGUAGE_ID_BENGALI': LanguageId.BENGALI,
    'LANGUAGE_ID_CANTONESE': LanguageId.CANTONESE,
    'LANGUAGE_ID_CATALAN': LanguageId.CATALAN,
    'LANGUAGE_ID_CHINESE_SIMPLIFIED': LanguageId.CHINESE_SIMPLIFIED,
    'LANGUAGE_ID_CHINESE_TRADITIONAL': LanguageId.CHINESE_TRADITIONAL,
    'LANGUAGE_ID_CZECH': LanguageId.CZECH,
    'LANGUAGE_ID_DANISH': LanguageId.DANISH,
    'LANGUAGE_ID_DUTCH': LanguageId.DUTCH,
    'LANGUAGE_ID_ENGLISH': LanguageId.ENGLISH,
    'LANGUAGE_ID_ESTONIAN': LanguageId.ESTONIAN,
    'LANGUAGE_ID_FINNISH': LanguageId.FINNISH,
    'LANGUAGE_ID_FRENCH_CANADA': LanguageId.FRENCH_CANADA,
    'LANGUAGE_ID_FRENCH_FRANCE': LanguageId.FRENCH_FRANCE,
    'LANGUAGE_ID_GERMAN': LanguageId.GERMAN,
    'LANGUAGE_ID_HEBREW': LanguageId.HEBREW,
    'LANGUAGE_ID_HINDI': LanguageId.HINDI,
    'LANGUAGE_ID_HUNGARIAN': LanguageId.HUNGARIAN,
    'LANGUAGE_ID_INDONESIAN': LanguageId.INDONESIAN,
    'LANGUAGE_ID_ITALIAN': LanguageId.ITALIAN,
    'LANGUAGE_ID_JAPANESE': LanguageId.JAPANESE,
    'LANGUAGE_ID_KOREAN': LanguageId.KOREAN,
    'LANGUAGE_ID_MALAY': LanguageId.MALAY,
    'LANGUAGE_ID_PERSIAN': LanguageId.PERSIAN,
    'LANGUAGE_ID_POLISH': LanguageId.POLISH,
    'LANGUAGE_ID_PORTUGUESE': LanguageId.PORTUGUESE,
    'LANGUAGE_ID_ROMANIAN': LanguageId.ROMANIAN,
    'LANGUAGE_ID_RUSSIAN': LanguageId.RUSSIAN,
    'LANGUAGE_ID_SPANISH': LanguageId.SPANISH,
    'LANGUAGE_ID_SWEDISH': LanguageId.SWEDISH,
    'LANGUAGE_ID_TAGALOG': LanguageId.TAGALOG,
    'LANGUAGE_ID_TAMIL': LanguageId.TAMIL,
    'LANGUAGE_ID_TELUGU': LanguageId.TELUGU,
    'LANGUAGE_ID_THAI': LanguageId.THAI,
    'LANGUAGE_ID_TURKISH': LanguageId.TURKISH,
    'LANGUAGE_ID_UKRAINIAN': LanguageId.UKRAINIAN,
    'LANGUAGE_ID_VIETNAMESE': LanguageId.VIETNAMESE,
}
