"""Human-readable lookup helpers for RTMS states, stop reasons, and status codes."""

from typing import Optional

_SESSION_STATES = {
    0: 'Session state: INACTIVE (default)',
    1: 'Session state: INITIALIZE (session is initializing)',
    2: 'Session state: STARTED (session has started)',
    3: 'Session state: PAUSED (session is paused)',
    4: 'Session state: RESUMED (session has resumed)',
    5: 'Session state: STOPPED (session has stopped)',
}

_STREAM_STATES = {
    0: 'Stream state: INACTIVE (default state)',
    1: 'Stream state: ACTIVE (media is being transmitted)',
    2: 'Stream state: INTERRUPTED (connection issue detected)',
    3: 'Stream state: TERMINATING (client notified to terminate)',
    4: 'Stream state: TERMINATED (stream has ended)',
    5: 'Stream state: PAUSED',
    6: 'Stream state: RESUMED',
}

_STOP_REASONS = {
    0: 'RTMS stopped: UNDEFINED',
    1: 'RTMS stopped: Host triggered (STOP_BC_HOST_TRIGGERED)',
    2: 'RTMS stopped: User triggered (STOP_BC_USER_TRIGGERED)',
    3: 'RTMS stopped: App user left meeting (STOP_BC_USER_LEFT)',
    4: 'RTMS stopped: App user ejected by host (STOP_BC_USER_EJECTED)',
    5: 'RTMS stopped: Host disabled app (STOP_BC_HOST_DISABLED_APP)',
    6: 'RTMS stopped: Meeting ended (STOP_BC_MEETING_ENDED)',
    7: 'RTMS stopped: Stream canceled by participant (STOP_BC_STREAM_CANCELED)',
    8: 'RTMS stopped: Stream revoked — delete assets immediately (STOP_BC_STREAM_REVOKED)',
    9: 'RTMS stopped: All apps disabled by host (STOP_BC_ALL_APPS_DISABLED)',
    10: 'RTMS stopped: Internal exception (STOP_BC_INTERNAL_EXCEPTION)',
    11: 'RTMS stopped: Connection timeout (STOP_BC_CONNECTION_TIMEOUT)',
    12: 'RTMS stopped: Instance connection interrupted (STOP_BC_INSTANCE_CONNECTION_INTERRUPTED)',
    13: 'RTMS stopped: Signaling connection interrupted (STOP_BC_SIGNAL_CONNECTION_INTERRUPTED)',
    14: 'RTMS stopped: Data connection interrupted (STOP_BC_DATA_CONNECTION_INTERRUPTED)',
    15: 'RTMS stopped: Signaling connection closed abnormally (STOP_BC_SIGNAL_CONNECTION_CLOSED_ABNORMALLY)',
    16: 'RTMS stopped: Data connection closed abnormally (STOP_BC_DATA_CONNECTION_CLOSED_ABNORMALLY)',
    17: 'RTMS stopped: Received exit signal (STOP_BC_EXIT_SIGNAL)',
    18: 'RTMS stopped: Authentication failure (STOP_BC_AUTHENTICATION_FAILURE)',
    19: 'RTMS stopped: Await reconnection timeout (STOP_BC_AWAIT_RECONNECTION_TIMEOUT)',
    20: 'RTMS stopped: Receiver requested close (STOP_BC_RECEIVER_REQUEST_CLOSE)',
    21: 'RTMS stopped: Customer disconnected (STOP_BC_CUSTOMER_DISCONNECTED)',
    22: 'RTMS stopped: Agent disconnected (STOP_BC_AGENT_DISCONNECTED)',
    23: 'RTMS stopped: Admin disabled app (STOP_BC_ADMIN_DISABLED_APP)',
    24: 'RTMS stopped: Keep-alive timeout (STOP_BC_KEEP_ALIVE_TIMEOUT)',
    25: 'RTMS stopped: Manual API triggered (STOP_BC_MANUAL_API_TRIGGERED)',
    26: 'RTMS stopped: Streaming not supported (STOP_BC_STREAMING_NOT_SUPPORTED)',
}

_STATUS_CODES = {
    0: 'RTMS status: OK',
    1: 'RTMS status: INVALID_MESSAGE_TYPE',
    2: 'RTMS status: INVALID_RTMS_STREAM_ID',
    3: 'RTMS status: INVALID_SIGNATURE',
    4: 'RTMS status: INVALID_PAYLOAD',
    5: 'RTMS status: INVALID_EVENTS',
    6: 'RTMS status: INVALID_EVENT_TYPE',
    7: 'RTMS status: INVALID_MEDIA_TYPE',
    8: 'RTMS status: DUPLICATE_SIGNAL_REQUEST',
    9: 'RTMS status: MEDIA_TYPE_AUDIO_NOT_SUPPORT',
    10: 'RTMS status: MEDIA_TYPE_VIDEO_NOT_SUPPORT',
    11: 'RTMS status: MEDIA_TYPE_DESKSHARE_NOT_SUPPORT',
    12: 'RTMS status: MEDIA_TYPE_TRANSCRIPT_NOT_SUPPORT',
    13: 'RTMS status: MEDIA_TYPE_CHAT_NOT_SUPPORT',
    14: 'RTMS status: MEDIA_TYPE_INVALID_VALUE',
    15: 'RTMS status: MEDIA_DATA_ALL_CONNECTION_EXIST',
    16: 'RTMS status: DUPLICATE_MEDIA_DATA_CONNECTION',
    17: 'RTMS status: INVALID_MEDIA_PARAMS',
    18: 'RTMS status: INVALID_MEDIA_AUDIO_PARAMS',
    19: 'RTMS status: INVALID_MEDIA_AUDIO_CONTENT_TYPE',
    20: 'RTMS status: INVALID_MEDIA_AUDIO_SAMPLE_RATE',
    21: 'RTMS status: INVALID_MEDIA_AUDIO_CHANNEL',
    22: 'RTMS status: INVALID_MEDIA_AUDIO_CODEC',
    23: 'RTMS status: INVALID_MEDIA_AUDIO_DATA_OPT',
    24: 'RTMS status: INVALID_MEDIA_AUDIO_SEND_RATE',
    25: 'RTMS status: INVALID_MEDIA_VIDEO_PARAMS',
    26: 'RTMS status: INVALID_MEDIA_VIDEO_CONTENT_TYPE',
    27: 'RTMS status: INVALID_MEDIA_VIDEO_CODEC',
    28: 'RTMS status: INVALID_MEDIA_VIDEO_RESOLUTION',
    29: 'RTMS status: INVALID_MEDIA_VIDEO_DATA_OPT',
    30: 'RTMS status: INVALID_MEDIA_VIDEO_FPS',
    31: 'RTMS status: INVALID_MEDIA_DESKSHARE_PARAMS',
    32: 'RTMS status: INVALID_MEDIA_DESKSHARE_CONTENT_TYPE',
    33: 'RTMS status: INVALID_MEDIA_DESKSHARE_CODEC',
    34: 'RTMS status: INVALID_MEDIA_DESKSHARE_RESOLUTION',
    35: 'RTMS status: INVALID_MEDIA_DESKSHARE_FPS',
    36: 'RTMS status: INVALID_MEDIA_TRANSCRIPT_PARAMS',
    37: 'RTMS status: INVALID_MEDIA_TRANSCRIPT_CONTENT_TYPE',
    38: 'RTMS status: INVALID_MEDIA_CHAT_PARAMS',
    39: 'RTMS status: INVALID_MEDIA_CHAT_CONTENT_TYPE',
    40: 'RTMS status: INVALID_RTMS_SESSION_ID',
    41: 'RTMS status: INVALID_CLIENT_READY_ACK',
    42: 'RTMS status: INVALID_EVENT_SUBSCRIBE',
    43: 'RTMS status: INVALID_MEDIA_TRANSCRIPT_SROUCE_LANGUAGE',
    44: 'RTMS status: DUPLICATE_VIDEO_SUBSCRIPTION',
    45: 'RTMS status: INTERNAL_EXCEPTION',
    46: 'RTMS status: INVALID_MEDIA_TRANSCRIPT_TARGET_LANGUAGE',
    47: 'RTMS status: CHAT_SESSION_KEY_NOT_AVAILABLE',
    48: 'RTMS status: MEDIA_DATA_TYPE_ALL_NOT_SUPPORTED (V2 requires one connection per media type)',
    49: 'RTMS status: PROTOCOL_V2_REQUIRED',
    50: 'RTMS status: PROTOBUF_V2_REQUIRED',
    51: 'RTMS status: DATA_HANDSHAKE_REQUIRES_ACTIVE_SIGNAL',
    52: 'RTMS status: HANDSHAKE_MESSAGE_FORMAT_MISMATCH',
    53: 'RTMS status: INVALID_VIDEO_SUBSCRIPTION_USER',
    54: 'RTMS status: INVALID_MEDIA_CONNECTION_ID',
    55: 'RTMS status: VIDEO_SUBSCRIPTION_CAP_EXCEEDED',
    56: 'RTMS status: FEATURE_NOT_SUPPORTED',
    57: 'RTMS status: INVALID_EVENT_CODE',
    58: 'RTMS status: MEDIA_PNG_NOT_SUPPORTED_IN_V2',
}


def get_rtms_session_state(state_code: Optional[int]) -> str:
    return _SESSION_STATES.get(state_code, f'Session state: Unknown state ({state_code})')


def get_rtms_stream_state(state_code: Optional[int]) -> str:
    return _STREAM_STATES.get(state_code, f'Stream state: Unknown state ({state_code})')


def get_rtms_stop_reason(error_code: Optional[int]) -> str:
    return _STOP_REASONS.get(error_code, f'RTMS stopped: Unknown reason code ({error_code})')


def get_rtms_status_code(status_code: Optional[int]) -> str:
    return _STATUS_CODES.get(status_code, f'RTMS status: Unknown status code ({status_code})')
