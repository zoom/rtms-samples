const PROTOCOL_MESSAGE_TYPES = Object.freeze({
  STREAM_CLOSE_REQ: 21,
  STREAM_CLOSE_RESP: 22,
  VIDEO_SUBSCRIPTION_REQ: 28,
  VIDEO_SUBSCRIPTION_RESP: 29
});

const PROTOCOL_EVENT_TYPES = Object.freeze({
  PARTICIPANT_VIDEO_ON: 8,
  PARTICIPANT_VIDEO_OFF: 9,
  CHAT_GROUP_CREATE: 10,
  CHAT_GROUP_DELETE: 11,
  CHAT_GROUP_MEMBERS_ADD: 12,
  CHAT_GROUP_MEMBERS_DELETE: 13,
  CHAT_GROUP_MEMBER_STATUS_UPDATE: 14
});

const PROTOCOL_MEDIA_DATA_OPTIONS = Object.freeze({
  VIDEO_SINGLE_INDIVIDUAL_STREAM: 4
});

const PROTOCOL_STATUS_CODES = Object.freeze({
  INVALID_MEDIA_TRANSCRIPT_TARGET_LANGUAGE: 46,
  CHAT_SESSION_KEY_NOT_AVAILABLE: 47
});

const PROTOCOL_CHAT_GROUP_TYPES = Object.freeze({
  PRIVATE_CHAT_GROUP: 0
});

const PROTOCOL_CHAT_GROUP_MEMBER_STATUSES = Object.freeze({
  IN_CHAT_GROUP: 0,
  IN_BREAKOUT_ROOM: 1,
  IN_WAITING_ROOM: 2,
  IN_BACKSTAGE: 3,
  LEFT_MEETING: 4
});

const PROTOCOL_CHAT_OPERATION_TYPES = Object.freeze({
  NEW: 1,
  DELETE: 2,
  UPDATE: 3,
  ADD_EMOJI_REACTION: 4,
  REMOVE_EMOJI_REACTION: 5
});

const PROTOCOL_CHAT_SESSION_TYPES = Object.freeze({
  EVERYONE: 1,
  INDIVIDUAL: 2,
  CHAT_GROUP: 3,
  HOSTS_AND_PANELISTS: 4,
  INDIVIDUAL_CC_HOSTS_AND_PANELISTS: 5
});

/**
 * Default protocol extensions aligned with the July 2026 RTMS protocol
 * definitions.
 */
export const RTMS_PROTOCOL_DEFINITIONS = Object.freeze({
  messageTypes: PROTOCOL_MESSAGE_TYPES,
  eventTypes: PROTOCOL_EVENT_TYPES,
  mediaDataOptions: PROTOCOL_MEDIA_DATA_OPTIONS,
  statusCodes: PROTOCOL_STATUS_CODES,
  chatGroupTypes: PROTOCOL_CHAT_GROUP_TYPES,
  chatGroupMemberStatuses: PROTOCOL_CHAT_GROUP_MEMBER_STATUSES,
  chatOperationTypes: PROTOCOL_CHAT_OPERATION_TYPES,
  chatSessionTypes: PROTOCOL_CHAT_SESSION_TYPES
});

export function getProtocolDefinitions(config = {}) {
  const overrides = config?.protocolDefinitions || {};
  return {
    messageTypes: {
      ...PROTOCOL_MESSAGE_TYPES,
      ...(overrides.messageTypes || {})
    },
    eventTypes: {
      ...PROTOCOL_EVENT_TYPES,
      ...(overrides.eventTypes || {})
    },
    mediaDataOptions: {
      ...PROTOCOL_MEDIA_DATA_OPTIONS,
      ...(overrides.mediaDataOptions || {})
    },
    statusCodes: {
      ...PROTOCOL_STATUS_CODES,
      ...(overrides.statusCodes || {})
    },
    chatGroupTypes: {
      ...PROTOCOL_CHAT_GROUP_TYPES,
      ...(overrides.chatGroupTypes || {})
    },
    chatGroupMemberStatuses: {
      ...PROTOCOL_CHAT_GROUP_MEMBER_STATUSES,
      ...(overrides.chatGroupMemberStatuses || {})
    },
    chatOperationTypes: {
      ...PROTOCOL_CHAT_OPERATION_TYPES,
      ...(overrides.chatOperationTypes || {})
    },
    chatSessionTypes: {
      ...PROTOCOL_CHAT_SESSION_TYPES,
      ...(overrides.chatSessionTypes || {})
    }
  };
}

export default RTMS_PROTOCOL_DEFINITIONS;
