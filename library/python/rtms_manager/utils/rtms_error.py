"""Developer-friendly RTMS error class aligned with JavaScript RTMSError.js."""

from typing import Any, Dict, List, Optional


ZOOM_STATUS_CODES: Dict[int, Dict[str, Any]] = {
    0: {'code': 'SUCCESS', 'message': 'Success', 'category': 'success'},
    1: {'code': 'STATUS_INVALID_MESSAGE_TYPE', 'message': 'Invalid message type', 'category': 'request'},
    2: {'code': 'STATUS_INVALID_RTMS_STREAM_ID', 'message': 'Invalid RTMS stream ID', 'category': 'stream'},
    3: {'code': 'STATUS_INVALID_SIGNATURE', 'message': 'Invalid signature', 'category': 'auth'},
    4: {'code': 'STATUS_INVALID_PAYLOAD', 'message': 'Invalid payload', 'category': 'request'},
    5: {'code': 'STATUS_INVALID_EVENTS', 'message': 'Invalid events array', 'category': 'request'},
    6: {'code': 'STATUS_INVALID_EVENT_TYPE', 'message': 'Invalid event type', 'category': 'request'},
    7: {'code': 'STATUS_INVALID_MEDIA_TYPE', 'message': 'Invalid media type', 'category': 'request'},
    8: {
        'code': 'STATUS_DUPLICATE_SIGNAL_REQUEST',
        'message': 'Duplicate signaling connection request',
        'category': 'connection',
        'causes': [
            'Another signaling connection for the same stream is still active',
            'The previous signaling socket has not fully closed yet',
            'Zoom retried the RTMS start flow while the old signaling connection was still shutting down',
        ],
        'fixes': [
            'Ensure only one signaling connection exists per RTMS stream',
            'Wait for the previous signaling socket to fully close before reconnecting',
            'Acknowledge webhook events immediately to avoid duplicate startup races',
        ],
    },
    9: {'code': 'STATUS_MEDIA_TYPE_AUDIO_NOT_SUPPORT', 'message': 'Audio media type is not supported', 'category': 'media'},
    10: {'code': 'STATUS_MEDIA_TYPE_VIDEO_NOT_SUPPORT', 'message': 'Video media type is not supported', 'category': 'media'},
    11: {'code': 'STATUS_MEDIA_TYPE_DESKSHARE_NOT_SUPPORT', 'message': 'Deskshare media type is not supported', 'category': 'media'},
    12: {'code': 'STATUS_MEDIA_TYPE_TRANSCRIPT_NOT_SUPPORT', 'message': 'Transcript media type is not supported', 'category': 'media'},
    13: {'code': 'STATUS_MEDIA_TYPE_CHAT_NOT_SUPPORT', 'message': 'Chat media type is not supported', 'category': 'media'},
    14: {
        'code': 'STATUS_MEDIA_TYPE_INVALID_VALUE',
        'message': 'media_type is not a concrete RTMS media value',
        'category': 'request',
        'causes': [
            'media_type in the RTMS data handshake is not one concrete RTMS media value',
            'media_types must select one or more concrete RTMS media types',
        ],
        'fixes': [
            'Use exactly one value: 1=audio, 2=video, 4=deskshare, 8=transcript, or 16=chat',
            'Open a separate data connection for every required media type',
        ],
        'docs_url': 'https://developers.zoom.us/docs/rtms/media-types/',
    },
    15: {'code': 'STATUS_MEDIA_DATA_ALL_CONNECTION_EXIST', 'message': 'A legacy aggregate media connection already exists', 'category': 'connection'},
    16: {'code': 'STATUS_DUPLICATE_MEDIA_DATA_CONNECTION', 'message': 'Duplicate media data connection detected', 'category': 'connection'},
    17: {'code': 'STATUS_INVALID_MEDIA_PARAMS', 'message': 'Invalid media_params payload', 'category': 'request'},
    18: {'code': 'STATUS_INVALID_MEDIA_AUDIO_PARAMS', 'message': 'Invalid audio media parameters', 'category': 'request'},
    19: {'code': 'STATUS_INVALID_MEDIA_AUDIO_CONTENT_TYPE', 'message': 'Invalid audio content_type', 'category': 'request'},
    20: {'code': 'STATUS_INVALID_MEDIA_AUDIO_SAMPLE_RATE', 'message': 'Invalid audio sample_rate', 'category': 'request'},
    21: {'code': 'STATUS_INVALID_MEDIA_AUDIO_CHANNEL', 'message': 'Invalid audio channel', 'category': 'request'},
    22: {'code': 'STATUS_INVALID_MEDIA_AUDIO_CODEC', 'message': 'Invalid audio codec', 'category': 'request'},
    23: {'code': 'STATUS_INVALID_MEDIA_AUDIO_DATA_OPT', 'message': 'Invalid audio data_opt', 'category': 'request'},
    24: {'code': 'STATUS_INVALID_MEDIA_AUDIO_SEND_RATE', 'message': 'Invalid audio send_rate', 'category': 'request'},
    25: {'code': 'STATUS_INVALID_MEDIA_VIDEO_PARAMS', 'message': 'Invalid video media parameters', 'category': 'request'},
    26: {'code': 'STATUS_INVALID_MEDIA_VIDEO_CONTENT_TYPE', 'message': 'Invalid video content_type', 'category': 'request'},
    27: {'code': 'STATUS_INVALID_MEDIA_VIDEO_CODEC', 'message': 'Invalid video codec', 'category': 'request'},
    28: {'code': 'STATUS_INVALID_MEDIA_VIDEO_RESOLUTION', 'message': 'Invalid video resolution', 'category': 'request'},
    29: {
        'code': 'STATUS_INVALID_MEDIA_VIDEO_DATA_OPT',
        'message': 'Invalid video data_opt',
        'category': 'request',
        'causes': [
            'The video data_opt value in the data handshake is not supported by the RTMS server build',
            'The client is using the wrong numeric value for VIDEO_SINGLE_INDIVIDUAL_STREAM',
            'The selected video mode is not compatible with the current RTMS deployment',
        ],
        'fixes': [
            'Verify video.data_opt matches the RTMS protocol definition used by your server build',
            'For single participant video, use VIDEO_SINGLE_INDIVIDUAL_STREAM = 4',
            'If active-stream video works but individual video fails, focus on video.data_opt instead of media_type',
        ],
        'docs_url': 'https://developers.zoom.us/docs/rtms/media-parameter-definition/',
    },
    30: {'code': 'STATUS_INVALID_MEDIA_VIDEO_FPS', 'message': 'Invalid video fps', 'category': 'request'},
    31: {'code': 'STATUS_INVALID_MEDIA_DESKSHARE_PARAMS', 'message': 'Invalid deskshare media parameters', 'category': 'request'},
    32: {'code': 'STATUS_INVALID_MEDIA_DESKSHARE_CONTENT_TYPE', 'message': 'Invalid deskshare content_type', 'category': 'request'},
    33: {'code': 'STATUS_INVALID_MEDIA_DESKSHARE_CODEC', 'message': 'Invalid deskshare codec', 'category': 'request'},
    34: {'code': 'STATUS_INVALID_MEDIA_DESKSHARE_RESOLUTION', 'message': 'Invalid deskshare resolution', 'category': 'request'},
    35: {'code': 'STATUS_INVALID_MEDIA_DESKSHARE_FPS', 'message': 'Invalid deskshare fps', 'category': 'request'},
    36: {'code': 'STATUS_INVALID_MEDIA_TRANSCRIPT_PARAMS', 'message': 'Invalid transcript media parameters', 'category': 'request'},
    37: {'code': 'STATUS_INVALID_MEDIA_TRANSCRIPT_CONTENT_TYPE', 'message': 'Invalid transcript content_type', 'category': 'request'},
    38: {'code': 'STATUS_INVALID_MEDIA_CHAT_PARAMS', 'message': 'Invalid chat media parameters', 'category': 'request'},
    39: {'code': 'STATUS_INVALID_MEDIA_CHAT_CONTENT_TYPE', 'message': 'Invalid chat content_type', 'category': 'request'},
    40: {'code': 'STATUS_INVALID_RTMS_SESSION_ID', 'message': 'Invalid RTMS session ID', 'category': 'stream'},
    41: {'code': 'STATUS_INVALID_CLIENT_READY_ACK', 'message': 'Invalid client ready acknowledgment', 'category': 'request'},
    42: {'code': 'STATUS_INVALID_EVENT_SUBSCRIBE', 'message': 'Invalid event subscribe payload', 'category': 'request'},
    43: {'code': 'STATUS_INVALID_MEDIA_TRANSCRIPT_SROUCE_LANGUAGE', 'message': 'Invalid transcript src_language', 'category': 'request'},
    44: {'code': 'STATUS_DUPLICATE_VIDEO_SUBSCRIPTION', 'message': 'Connection or participant already has an active video subscription', 'category': 'request'},
    45: {'code': 'STATUS_INTERNAL_EXCEPTION', 'message': 'RTMS internal exception', 'category': 'server'},
    46: {'code': 'STATUS_INVALID_MEDIA_TRANSCRIPT_TARGET_LANGUAGE', 'message': 'Invalid transcript target language', 'category': 'request'},
    47: {'code': 'STATUS_CHAT_SESSION_KEY_NOT_AVAILABLE', 'message': 'Chat session key is not available', 'category': 'server'},
    48: {'code': 'STATUS_MEDIA_DATA_TYPE_ALL_NOT_SUPPORTED', 'message': 'media_type 32 (ALL) is not supported in protocol V2; open one connection per media type', 'category': 'request'},
    49: {'code': 'STATUS_PROTOCOL_V2_REQUIRED', 'message': 'This feature requires RTMS protocol V2', 'category': 'request'},
    50: {'code': 'STATUS_PROTOBUF_V2_REQUIRED', 'message': 'Protobuf framing requires RTMS protocol V2', 'category': 'request'},
    51: {'code': 'STATUS_DATA_HANDSHAKE_REQUIRES_ACTIVE_SIGNAL', 'message': 'Data handshake requires an active signaling connection', 'category': 'connection'},
    52: {'code': 'STATUS_HANDSHAKE_MESSAGE_FORMAT_MISMATCH', 'message': 'Data handshake format differs from the signaling connection format', 'category': 'request'},
    53: {'code': 'STATUS_INVALID_VIDEO_SUBSCRIPTION_USER', 'message': 'Video subscription user is invalid or not in the roster', 'category': 'request'},
    54: {'code': 'STATUS_INVALID_MEDIA_CONNECTION_ID', 'message': 'Invalid or closed media connection_id', 'category': 'request'},
    55: {'code': 'STATUS_VIDEO_SUBSCRIPTION_CAP_EXCEEDED', 'message': 'Video subscription capacity exceeded', 'category': 'media'},
    56: {'code': 'STATUS_FEATURE_NOT_SUPPORTED', 'message': 'Feature is not enabled for this service', 'category': 'config'},
    57: {'code': 'STATUS_INVALID_EVENT_CODE', 'message': 'Invalid event_code', 'category': 'request'},
    58: {'code': 'STATUS_MEDIA_PNG_NOT_SUPPORTED_IN_V2', 'message': 'PNG codec is not supported in protocol V2; use JPG or H.264', 'category': 'request'},
}

ERROR_GUIDANCE: Dict[str, Dict[str, Any]] = {
    'auth': {
        'causes': [
            'client_secret does not match client_id',
            'Using Meeting SDK credentials for Video SDK (or vice versa)',
            'Credentials were regenerated but not updated in your app',
            'Clock skew between your server and Zoom servers',
        ],
        'fixes': [
            'Verify client_id and client_secret match in Zoom Marketplace -> App Credentials',
            'For Video SDK: use Video SDK app credentials, not Meeting SDK',
            'Check .env file has no extra spaces around values',
            'Ensure your server time is synchronized (use NTP)',
        ],
        'docs_url': 'https://developers.zoom.us/docs/rtms/auth/',
    },
    'meeting': {
        'causes': [
            'Meeting has already ended',
            'Meeting UUID format is incorrect',
            'Meeting was deleted or never existed',
            'Using a meeting ID instead of meeting UUID',
        ],
        'fixes': [
            'Use the meeting_uuid from the webhook, not the meeting ID',
            'Ensure the meeting is still active when connecting',
            'Check that the webhook payload is being parsed correctly',
        ],
        'docs_url': 'https://developers.zoom.us/docs/rtms/webhooks/',
    },
    'stream': {
        'causes': [
            'Stream has already been stopped',
            'Stream ID was not found in active streams',
            'Using an old stream ID from a previous session',
        ],
        'fixes': [
            'Use the rtms_stream_id from the current webhook event',
            'Handle rtms_stopped webhooks to clean up stream references',
            'Check stream lifecycle in your application logic',
        ],
        'docs_url': 'https://developers.zoom.us/docs/rtms/stream-lifecycle/',
    },
    'permission': {
        'causes': [
            'RTMS is not enabled for this Zoom account',
            'App does not have RTMS scopes',
            'Meeting host has not granted RTMS permission',
            'Account-level RTMS feature is disabled',
        ],
        'fixes': [
            'Enable RTMS in Zoom Admin Portal -> Account Settings',
            'Add RTMS scopes to your app in Zoom Marketplace',
            'Ensure meeting host allows real-time media streaming',
        ],
        'docs_url': 'https://developers.zoom.us/docs/rtms/prerequisites/',
    },
    'network': {
        'causes': [
            'Network connection was interrupted',
            'Firewall blocking WebSocket connections',
            'DNS resolution failed',
            'Zoom server region is unreachable',
        ],
        'fixes': [
            'Check network connectivity to Zoom servers',
            'Allow outbound WebSocket connections (wss://) on port 443',
            'Verify DNS can resolve *.zoom.us domains',
        ],
        'docs_url': 'https://developers.zoom.us/docs/rtms/troubleshooting/',
    },
    'server': {
        'causes': [
            'Zoom RTMS service is experiencing issues',
            'Temporary server overload',
            'Maintenance window in progress',
        ],
        'fixes': [
            'Check Zoom status page: https://status.zoom.us',
            'Implement exponential backoff retry logic',
            'Wait a few minutes and try again',
        ],
        'docs_url': 'https://status.zoom.us',
    },
    'limit': {
        'causes': [
            'Too many API requests in a short time',
            'Maximum concurrent connections reached',
            'Account-level rate limit exceeded',
        ],
        'fixes': [
            'Implement rate limiting in your application',
            'Use exponential backoff for retries',
        ],
        'docs_url': 'https://developers.zoom.us/docs/api/rate-limits/',
    },
    'media': {
        'causes': [
            'Requested media type is not being shared in the meeting',
            'Participant has not enabled video/audio',
            'Screen sharing has not started',
        ],
        'fixes': [
            'Check which media types are available in the meeting',
            'Subscribe only to media types that are active',
            'Handle SHARING_START/SHARING_STOP events',
        ],
        'docs_url': 'https://developers.zoom.us/docs/rtms/media-types/',
    },
    'protocol': {
        'causes': ['RTMS protocol version mismatch', 'Incompatible message format'],
        'fixes': ['Update to the latest rtms_manager version', 'Ensure message payloads match expected format'],
        'docs_url': 'https://developers.zoom.us/docs/rtms/changelog/',
    },
    'security': {
        'causes': ['Encryption key mismatch', 'Payload decryption failed', 'Security certificate issue'],
        'fixes': ['Verify client_secret is correct', 'Ensure TLS certificates are valid'],
        'docs_url': 'https://developers.zoom.us/docs/rtms/security/',
    },
    'connection': {
        'causes': [
            'Another connection with same credentials already exists',
            'Previous connection was not properly closed',
            'Reconnecting too quickly after disconnect',
        ],
        'fixes': [
            'Ensure only one connection per stream ID',
            'Properly close connections before reconnecting',
            'Add a delay before reconnection attempts',
        ],
        'docs_url': 'https://developers.zoom.us/docs/rtms/connection-management/',
    },
    'request': {
        'causes': ['Missing required parameter', 'Invalid parameter format', 'Unexpected parameter value'],
        'fixes': [
            'Check all required parameters are provided',
            'Verify parameter formats match documentation',
            'Review the full request payload for issues',
        ],
        'docs_url': 'https://developers.zoom.us/docs/rtms/api-reference/',
    },
}

SDK_ERROR_CODES: Dict[str, Dict[str, Any]] = {
    'NOT_INITIALIZED': {
        'code': 'NOT_INITIALIZED',
        'message': 'RTMSManager.init() must be called before using the SDK',
        'category': 'sdk',
        'causes': ['RTMSManager.init() was not called', 'init() failed silently'],
        'fixes': ['Call await RTMSManager.init({...}) before using other methods'],
        'docs_url': 'https://developers.zoom.us/docs/rtms/quickstart/',
    },
    'MISSING_CREDENTIALS': {
        'code': 'MISSING_CREDENTIALS',
        'message': 'Missing required credentials',
        'category': 'config',
        'causes': ['client_id, client_secret, or secret_token not provided', 'Credentials object is empty'],
        'fixes': ['Provide all required credentials in init() config', 'Check your .env file is loaded'],
        'docs_url': 'https://developers.zoom.us/docs/rtms/configuration/',
    },
    'INVALID_CONFIG': {
        'code': 'INVALID_CONFIG',
        'message': 'Invalid configuration',
        'category': 'config',
        'causes': ['Configuration object has invalid values', 'media_types value is out of range'],
        'fixes': ['Review configuration options in documentation', 'Use RTMSManager.MEDIA.* constants'],
        'docs_url': 'https://developers.zoom.us/docs/rtms/configuration/',
    },
    'CONNECTION_FAILED': {
        'code': 'CONNECTION_FAILED',
        'message': 'Failed to establish WebSocket connection',
        'category': 'network',
        'causes': ['Network connectivity issue', 'Firewall blocking connection', 'Invalid or disallowed server URL'],
        'fixes': ['Check network connectivity', 'Allow wss:// connections to *.zoom.us'],
        'docs_url': 'https://developers.zoom.us/docs/rtms/troubleshooting/',
    },
    'SIGNALING_ERROR': {
        'code': 'SIGNALING_ERROR',
        'message': 'Signaling socket error',
        'category': 'connection',
        'causes': ['Signaling connection dropped', 'Server rejected connection'],
        'fixes': ['Check credentials are correct', 'Verify meeting is still active'],
        'docs_url': 'https://developers.zoom.us/docs/rtms/signaling/',
    },
    'MEDIA_ERROR': {
        'code': 'MEDIA_ERROR',
        'message': 'Media socket error',
        'category': 'media',
        'causes': ['Media connection dropped', 'Media type not available'],
        'fixes': ['Check requested media types are being shared', 'Handle media availability events'],
        'docs_url': 'https://developers.zoom.us/docs/rtms/media/',
    },
}

NON_RETRYABLE_CATEGORIES = frozenset({'auth', 'security', 'request', 'meeting', 'stream'})


class RTMSError(RuntimeError):
    """Enhanced error class for RTMS operations (subclasses RuntimeError for compatibility)."""

    def __init__(
        self,
        code: str,
        message: Optional[str] = None,
        *,
        zoom_status: Optional[int] = None,
        meeting_id: Optional[str] = None,
        stream_id: Optional[str] = None,
        request_msg_type: Optional[int] = None,
        cause: Optional[BaseException] = None,
    ) -> None:
        if zoom_status is not None and zoom_status in ZOOM_STATUS_CODES:
            error_info = ZOOM_STATUS_CODES[zoom_status]
        elif code in SDK_ERROR_CODES:
            error_info = SDK_ERROR_CODES[code]
        else:
            error_info = {'code': code, 'message': message or 'Unknown error', 'category': 'unknown'}

        final_message = message or error_info['message']
        super().__init__(final_message)

        self.code: str = error_info.get('code', code)
        self.message: str = final_message
        self.category: str = error_info.get('category', 'unknown')
        self.zoom_status: Optional[int] = zoom_status
        self.status_code: Optional[int] = zoom_status
        self.meeting_id: Optional[str] = meeting_id
        self.rtms_id: Optional[str] = meeting_id
        self.stream_id: Optional[str] = stream_id
        self.request_msg_type: Optional[int] = request_msg_type
        self.original_error: Optional[BaseException] = cause

        guidance = ERROR_GUIDANCE.get(self.category, {
            'causes': ['Unknown error occurred'],
            'fixes': ['Check logs for more details', 'Report issue at https://github.com/zoom/rtms-samples/issues'],
            'docs_url': 'https://developers.zoom.us/docs/rtms/',
        })
        self.causes: List[str] = list(error_info.get('causes', guidance['causes']))
        self.fixes: List[str] = list(error_info.get('fixes', guidance['fixes']))
        self.docs_url: str = error_info.get('docs_url', guidance['docs_url'])

    @classmethod
    def from_zoom_status(
        cls,
        status_code: Optional[int],
        *,
        meeting_id: Optional[str] = None,
        stream_id: Optional[str] = None,
        request_msg_type: Optional[int] = None,
    ) -> 'RTMSError':
        info = ZOOM_STATUS_CODES.get(status_code) if status_code is not None else None
        if not info:
            return cls(
                'UNKNOWN_STATUS',
                f'Unknown Zoom status code: {status_code}',
                zoom_status=status_code,
                meeting_id=meeting_id,
                stream_id=stream_id,
                request_msg_type=request_msg_type,
            )
        return cls(
            info['code'],
            info['message'],
            zoom_status=status_code,
            meeting_id=meeting_id,
            stream_id=stream_id,
            request_msg_type=request_msg_type,
        )

    @classmethod
    def from_code(
        cls,
        code: str,
        *,
        message: Optional[str] = None,
        meeting_id: Optional[str] = None,
        stream_id: Optional[str] = None,
        cause: Optional[BaseException] = None,
    ) -> 'RTMSError':
        return cls(code, message, meeting_id=meeting_id, stream_id=stream_id, cause=cause)

    def to_short_string(self) -> str:
        text = f'[{self.code}] {self.message}'
        if self.zoom_status is not None:
            text += f' (status: {self.zoom_status})'
        return text

    def to_dict(self) -> Dict[str, Any]:
        return {
            'name': 'RTMSError',
            'code': self.code,
            'message': self.message,
            'category': self.category,
            'zoom_status': self.zoom_status,
            'status_code': self.zoom_status,
            'meeting_id': self.meeting_id,
            'rtms_id': self.meeting_id,
            'stream_id': self.stream_id,
            'request_msg_type': self.request_msg_type,
            'causes': self.causes,
            'fixes': self.fixes,
            'docs_url': self.docs_url,
        }

    def __str__(self) -> str:
        lines = [
            '============================================================',
            f'RTMSError: {self.message}',
            '============================================================',
            '',
        ]
        code_line = f'   Code: {self.code}'
        if self.zoom_status is not None:
            code_line += f' (Zoom status: {self.zoom_status})'
        lines.append(code_line)
        lines.append(f'   Category: {self.category}')
        if self.meeting_id:
            lines.append(f'   Meeting: {self.meeting_id}')
        if self.stream_id:
            lines.append(f'   Stream: {self.stream_id}')
        if self.causes:
            lines.extend(['', '   Possible causes:'])
            for idx, cause in enumerate(self.causes, 1):
                lines.append(f'   {idx}. {cause}')
        if self.fixes:
            lines.extend(['', '   How to fix:'])
            for idx, fix in enumerate(self.fixes, 1):
                lines.append(f'   {idx}. {fix}')
        if self.docs_url:
            lines.extend(['', f'   Docs: {self.docs_url}'])
        lines.append('============================================================')
        return '\n'.join(lines)
