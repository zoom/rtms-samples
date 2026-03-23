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


@dataclass
class ProtocolMediaDataOptions:
    VIDEO_SINGLE_INDIVIDUAL_STREAM: int = 4


@dataclass
class RTMSProtocolDefinitions:
    """
    Default protocol extensions aligned with the March 2026 RTMS
    protocol definitions.
    """
    message_types: ProtocolMessageTypes = field(default_factory=ProtocolMessageTypes)
    event_types: ProtocolEventTypes = field(default_factory=ProtocolEventTypes)
    media_data_options: ProtocolMediaDataOptions = field(default_factory=ProtocolMediaDataOptions)

    def to_dict(self) -> Dict[str, Dict[str, int]]:
        return {
            'message_types': self.message_types.__dict__.copy(),
            'event_types': self.event_types.__dict__.copy(),
            'media_data_options': self.media_data_options.__dict__.copy(),
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

    return merged
