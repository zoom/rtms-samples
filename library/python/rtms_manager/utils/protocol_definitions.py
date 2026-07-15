from dataclasses import dataclass, field
from typing import Dict, Any


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
