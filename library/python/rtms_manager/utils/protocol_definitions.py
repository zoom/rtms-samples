from dataclasses import dataclass, field
from typing import Dict, Any, Optional


# RTMS protocol V2 is the default. Set protocol_version=1 in the manager
# options to fall back to V1 (Zoom Phone always uses V2 or later).
DEFAULT_RTMS_PROTOCOL_VERSION = 2

# V2 replaces the legacy event_type with event_code, in both event
# subscriptions (msg_type 5) and event updates (msg_type 6).
# Keys are legacy RTMS_EVENT_TYPE values; values are RTMS_EVENT_CODE values.
LEGACY_EVENT_TYPE_TO_EVENT_CODE = {
    1: 1,      # FIRST_PACKET_TIMESTAMP (sent automatically)
    2: 1000,   # ACTIVE_SPEAKER_CHANGE
    3: 1001,   # PARTICIPANT_JOIN
    4: 1002,   # PARTICIPANT_LEAVE
    5: 1003,   # SHARING_START
    6: 1004,   # SHARING_STOP
    7: 2,      # MEDIA_CONNECTION_INTERRUPTED (sent automatically)
    8: 1005,   # PARTICIPANT_VIDEO_ON
    9: 1006,   # PARTICIPANT_VIDEO_OFF
    10: 1007,  # CHAT_GROUP_CREATE
    11: 1008,  # CHAT_GROUP_DELETE
    12: 1009,  # CHAT_GROUP_MEMBERS_ADD
    13: 1010,  # CHAT_GROUP_MEMBERS_DELETE
    14: 1011,  # CHAT_GROUP_MEMBER_STATUS_UPDATE
    15: 3,     # VIDEO_SUBSCRIPTION_TERMINATED_BY_USER_LEAVE (sent automatically)
}

EVENT_CODE_TO_LEGACY_EVENT_TYPE = {code: event_type for event_type, code in LEGACY_EVENT_TYPE_TO_EVENT_CODE.items()}


def is_subscribable_event_code(code: Optional[int]) -> bool:
    """Only session events 1000-1011 can be subscribed to through JSON in V2."""
    return isinstance(code, int) and 1000 <= code <= 1011


def resolve_protocol_version(rtms_type: Optional[str], configured: Any = None) -> int:
    try:
        version = int(configured) if configured is not None else 0
    except (TypeError, ValueError):
        version = 0
    version = version or DEFAULT_RTMS_PROTOCOL_VERSION
    if rtms_type == 'phone':
        return max(2, version)
    return version


@dataclass
class ProtocolMessageTypes:
    STREAM_CLOSE_REQ: int = 21
    STREAM_CLOSE_RESP: int = 22
    VIDEO_SUBSCRIPTION_REQ: int = 28
    VIDEO_SUBSCRIPTION_RESP: int = 29


@dataclass
class ProtocolEventTypes:
    PARTICIPANT_VIDEO_ON: int = 8
    PARTICIPANT_VIDEO_OFF: int = 9
    CHAT_GROUP_CREATE: int = 10
    CHAT_GROUP_DELETE: int = 11
    CHAT_GROUP_MEMBERS_ADD: int = 12
    CHAT_GROUP_MEMBERS_DELETE: int = 13
    CHAT_GROUP_MEMBER_STATUS_UPDATE: int = 14


@dataclass
class ProtocolMediaDataOptions:
    VIDEO_SINGLE_INDIVIDUAL_STREAM: int = 4


@dataclass
class ProtocolStatusCodes:
    INVALID_MEDIA_TRANSCRIPT_TARGET_LANGUAGE: int = 46
    CHAT_SESSION_KEY_NOT_AVAILABLE: int = 47


@dataclass
class ProtocolChatGroupTypes:
    PRIVATE_CHAT_GROUP: int = 0


@dataclass
class ProtocolChatGroupMemberStatuses:
    IN_CHAT_GROUP: int = 0
    IN_BREAKOUT_ROOM: int = 1
    IN_WAITING_ROOM: int = 2
    IN_BACKSTAGE: int = 3
    LEFT_MEETING: int = 4


@dataclass
class ProtocolChatOperationTypes:
    NEW: int = 1
    DELETE: int = 2
    UPDATE: int = 3
    ADD_EMOJI_REACTION: int = 4
    REMOVE_EMOJI_REACTION: int = 5


@dataclass
class ProtocolChatSessionTypes:
    EVERYONE: int = 1
    INDIVIDUAL: int = 2
    CHAT_GROUP: int = 3
    HOSTS_AND_PANELISTS: int = 4
    INDIVIDUAL_CC_HOSTS_AND_PANELISTS: int = 5


@dataclass
class RTMSProtocolDefinitions:
    """
    Default protocol extensions aligned with the July 2026 RTMS
    protocol definitions.
    """
    message_types: ProtocolMessageTypes = field(default_factory=ProtocolMessageTypes)
    event_types: ProtocolEventTypes = field(default_factory=ProtocolEventTypes)
    media_data_options: ProtocolMediaDataOptions = field(default_factory=ProtocolMediaDataOptions)
    status_codes: ProtocolStatusCodes = field(default_factory=ProtocolStatusCodes)
    chat_group_types: ProtocolChatGroupTypes = field(default_factory=ProtocolChatGroupTypes)
    chat_group_member_statuses: ProtocolChatGroupMemberStatuses = field(default_factory=ProtocolChatGroupMemberStatuses)
    chat_operation_types: ProtocolChatOperationTypes = field(default_factory=ProtocolChatOperationTypes)
    chat_session_types: ProtocolChatSessionTypes = field(default_factory=ProtocolChatSessionTypes)

    def to_dict(self) -> Dict[str, Dict[str, int]]:
        return {
            'message_types': self.message_types.__dict__.copy(),
            'event_types': self.event_types.__dict__.copy(),
            'media_data_options': self.media_data_options.__dict__.copy(),
            'status_codes': self.status_codes.__dict__.copy(),
            'chat_group_types': self.chat_group_types.__dict__.copy(),
            'chat_group_member_statuses': self.chat_group_member_statuses.__dict__.copy(),
            'chat_operation_types': self.chat_operation_types.__dict__.copy(),
            'chat_session_types': self.chat_session_types.__dict__.copy(),
        }


RTMS_PROTOCOL_DEFINITIONS = RTMSProtocolDefinitions()


def merge_protocol_definitions(overrides: Dict[str, Any] | None = None) -> RTMSProtocolDefinitions:
    overrides = overrides or {}
    merged = RTMSProtocolDefinitions()

    message_types = overrides.get('message_types', overrides.get('messageTypes', {}))
    for key, value in message_types.items():
        if hasattr(merged.message_types, key):
            setattr(merged.message_types, key, value)

    event_types = overrides.get('event_types', overrides.get('eventTypes', {}))
    for key, value in event_types.items():
        if hasattr(merged.event_types, key):
            setattr(merged.event_types, key, value)

    media_data_options = overrides.get('media_data_options', overrides.get('mediaDataOptions', {}))
    for key, value in media_data_options.items():
        if hasattr(merged.media_data_options, key):
            setattr(merged.media_data_options, key, value)

    for attr_name, snake_key, camel_key in (
        ('status_codes', 'status_codes', 'statusCodes'),
        ('chat_group_types', 'chat_group_types', 'chatGroupTypes'),
        ('chat_group_member_statuses', 'chat_group_member_statuses', 'chatGroupMemberStatuses'),
        ('chat_operation_types', 'chat_operation_types', 'chatOperationTypes'),
        ('chat_session_types', 'chat_session_types', 'chatSessionTypes'),
    ):
        values = overrides.get(snake_key, overrides.get(camel_key, {}))
        target = getattr(merged, attr_name)
        for key, value in values.items():
            if hasattr(target, key):
                setattr(target, key, value)

    return merged
