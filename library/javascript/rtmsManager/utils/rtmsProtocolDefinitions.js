const PROTOCOL_MESSAGE_TYPES = Object.freeze({
  STREAM_CLOSE_REQ: 21,
  STREAM_CLOSE_RESP: 22,
  VIDEO_SUBSCRIPTION_REQ: 28,
  VIDEO_SUBSCRIPTION_RESP: 29
});

const PROTOCOL_EVENT_TYPES = Object.freeze({
  PARTICIPANT_VIDEO_ON: 8,
  PARTICIPANT_VIDEO_OFF: 9
});

const PROTOCOL_MEDIA_DATA_OPTIONS = Object.freeze({
  VIDEO_SINGLE_INDIVIDUAL_STREAM: 4
});

/**
 * Default protocol extensions aligned with the March 2026 RTMS protocol
 * definitions.
 */
export const RTMS_PROTOCOL_DEFINITIONS = Object.freeze({
  messageTypes: PROTOCOL_MESSAGE_TYPES,
  eventTypes: PROTOCOL_EVENT_TYPES,
  mediaDataOptions: PROTOCOL_MEDIA_DATA_OPTIONS
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
    }
  };
}

export default RTMS_PROTOCOL_DEFINITIONS;
