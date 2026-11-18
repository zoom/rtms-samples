import WebSocket from 'ws';
import {
  getRtmsSessionState,
  getRtmsStreamState,
  getRtmsStopReason,
  getRtmsStatusCode
} from './utils/rtmsEventLookupHelper.js';
import { connectToMediaWebSocket } from './mediaSocket.js';
import { FileLogger } from './utils/FileLogger.js';
import { RTMSFlagHelper, TYPE_FLAGS } from './utils/RTMSFlagHelper.js';
import { RTMSError } from './utils/RTMSError.js';
import { getPreferredMediaUrl } from './utils/rtmsEntityHelper.js';
import { getProtocolDefinitions } from './utils/rtmsProtocolDefinitions.js';

const MAX_DUPLICATE_SIGNAL_RETRIES = 3;
const INITIAL_DUPLICATE_SIGNAL_RETRY_DELAY_MS = 1500;

// RTMS protocol V2 event codes (RTMS_EVENT_CODE). V2 streams such as Zoom
// Phone report events with event_code instead of the legacy event_type.
export const RTMS_EVENT_CODES = Object.freeze({
  FIRST_PACKET_TIMESTAMP: 1,
  MEDIA_CONNECTION_INTERRUPTED: 2,
  ZP_CALL_INFO_UPDATED: 3000,
  ZP_CALL_HOLD: 3001,
  ZP_CALL_RESUME: 3002,
  ZP_CALL_TRANSFER_COMPLETED: 3003
});

const PHONE_EVENT_NAMES = Object.freeze({
  [RTMS_EVENT_CODES.ZP_CALL_INFO_UPDATED]: 'phone_call_info_updated',
  [RTMS_EVENT_CODES.ZP_CALL_HOLD]: 'phone_call_hold',
  [RTMS_EVENT_CODES.ZP_CALL_RESUME]: 'phone_call_resume',
  [RTMS_EVENT_CODES.ZP_CALL_TRANSFER_COMPLETED]: 'phone_call_transfer_completed'
});

function normalizePhoneParticipant(participant = {}) {
  return {
    channelId: participant.channel_id ?? null,
    name: participant.name ?? null,
    // The published payload names this field "phone_number/extension_number".
    number: participant.phone_number
      ?? participant.extension_number
      ?? participant['phone_number/extension_number']
      ?? null
  };
}

function handleEventCode(msg, meetingUuid, streamId, conn, emit) {
  const event = msg.event;
  const base = {
    eventCode: event.event_code,
    data: event,
    rtmsId: meetingUuid,
    meetingId: meetingUuid,
    streamId,
    productType: conn.rtmsType || 'meeting',
    timestamp: event.timestamp || Date.now()
  };

  switch (event.event_code) {
    case RTMS_EVENT_CODES.FIRST_PACKET_TIMESTAMP:
      FileLogger.log(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] FIRST_PACKET_TIMESTAMP: ${event.timestamp}`);
      conn.setFirstPacketTimestamp(event.timestamp);
      return;

    case RTMS_EVENT_CODES.MEDIA_CONNECTION_INTERRUPTED:
      FileLogger.log(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] MEDIA_CONNECTION_INTERRUPTED (media_type ${event.media_type ?? 'unknown'})`);
      emit('media_connection_interrupted', { type: 'media_connection_interrupted', mediaType: event.media_type ?? null, ...base });
      return;

    case RTMS_EVENT_CODES.ZP_CALL_INFO_UPDATED: {
      const participants = Array.isArray(event.participants)
        ? event.participants.map(normalizePhoneParticipant)
        : [];
      conn.setPhoneCallInfo?.({ hostChannelId: event.host_channel_id ?? null, participants });
      FileLogger.log(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] CALL_INFO_UPDATED: ${participants.map((p) => p.name || p.channelId).join(', ')}`);
      emit(PHONE_EVENT_NAMES[event.event_code], {
        type: PHONE_EVENT_NAMES[event.event_code],
        hostChannelId: event.host_channel_id ?? null,
        participants,
        ...base
      });
      return;
    }

    case RTMS_EVENT_CODES.ZP_CALL_HOLD:
    case RTMS_EVENT_CODES.ZP_CALL_RESUME:
      FileLogger.log(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] ${PHONE_EVENT_NAMES[event.event_code]}`);
      emit(PHONE_EVENT_NAMES[event.event_code], { type: PHONE_EVENT_NAMES[event.event_code], ...base });
      return;

    case RTMS_EVENT_CODES.ZP_CALL_TRANSFER_COMPLETED:
      FileLogger.log(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] TRANSFER_COMPLETED: ${event.transfer_type || 'unknown'}`);
      emit(PHONE_EVENT_NAMES[event.event_code], {
        type: PHONE_EVENT_NAMES[event.event_code],
        transferType: event.transfer_type ?? null,
        transferResult: event.transfer_result ?? null,
        ...base
      });
      return;

    default:
      FileLogger.log(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] Unhandled event_code: ${event.event_code}`);
  }
}

function getVideoParticipants(event = {}) {
  if (Array.isArray(event.participants) && event.participants.length > 0) {
    return event.participants.map((participant) => ({
      userId: participant.user_id,
      userName: participant.user_name || null
    }));
  }

  if (event.user_id == null) {
    return [];
  }

  return [{
    userId: event.user_id,
    userName: event.user_name || null
  }];
}

function upsertVideoParticipants(conn, participants = []) {
  if (!conn.videoOnParticipants) {
    conn.videoOnParticipants = new Map();
  }

  participants.forEach((participant) => {
    if (participant?.userId == null) return;
    const key = String(participant.userId);
    const existing = conn.videoOnParticipants.get(key) || {};
    conn.videoOnParticipants.set(key, {
      userId: participant.userId,
      userName: participant.userName ?? existing.userName ?? null
    });
  });
}

function removeVideoParticipants(conn, participants = []) {
  if (!conn.videoOnParticipants) {
    conn.videoOnParticipants = new Map();
  }

  const removedParticipants = [];
  participants.forEach((participant) => {
    if (participant?.userId == null) return;
    const key = String(participant.userId);
    if (!conn.videoOnParticipants.has(key)) return;
    removedParticipants.push(participant);
    conn.videoOnParticipants.delete(key);
    if (conn.currentVideoSubscriptionUserId != null && String(conn.currentVideoSubscriptionUserId) === String(participant.userId)) {
      conn.currentVideoSubscriptionUserId = null;
    }
  });
  return removedParticipants;
}

function emitVideoParticipantSnapshot(eventName, participants, msg, meetingUuid, streamId, conn, emit) {
  emit(eventName, {
    type: eventName,
    participants,
    availableParticipants: conn.getVideoOnParticipants ? conn.getVideoOnParticipants() : [],
    data: msg.event,
    rtmsId: meetingUuid,
    meetingId: meetingUuid,
    streamId,
    productType: conn.rtmsType || 'meeting',
    timestamp: msg.event?.timestamp || Date.now()
  });
}

function shouldSubscribeToIndividualVideoEvents(conn, mediaTypesFlag) {
  const protocol = getProtocolDefinitions(conn.config);
  const requestedVideo = Boolean(mediaTypesFlag & TYPE_FLAGS.video);
  return requestedVideo && conn.config?.mediaParams?.video?.data_opt === protocol.mediaDataOptions.VIDEO_SINGLE_INDIVIDUAL_STREAM;
}

function shouldSubscribeToChatGroupEvents(mediaTypesFlag) {
  return Boolean(mediaTypesFlag & TYPE_FLAGS.chat);
}

function emitChatGroupEvent(eventName, msg, meetingUuid, streamId, conn, emit) {
  emit(eventName, {
    type: eventName,
    eventType: msg.event.event_type,
    data: msg.event,
    rtmsId: meetingUuid,
    meetingId: meetingUuid,
    streamId,
    productType: conn.rtmsType || 'meeting',
    timestamp: msg.event.timestamp || Date.now()
  });
}

function buildEventSubscriptionPayload(conn, mediaTypesFlag) {
  const protocol = getProtocolDefinitions(conn.config);
  const subscribeAllKnownEvents = conn.config?.subscribeAllKnownEvents === true;
  const knownEventTypes = [
    2, // ACTIVE_SPEAKER_CHANGE
    3, // PARTICIPANT_JOIN
    4, // PARTICIPANT_LEAVE
    5, // SHARING_START
    6, // SHARING_STOP
    7, // MEDIA_CONNECTION_INTERRUPTED
    protocol.eventTypes.PARTICIPANT_VIDEO_ON,
    protocol.eventTypes.PARTICIPANT_VIDEO_OFF,
    protocol.eventTypes.CHAT_GROUP_CREATE,
    protocol.eventTypes.CHAT_GROUP_DELETE,
    protocol.eventTypes.CHAT_GROUP_MEMBERS_ADD,
    protocol.eventTypes.CHAT_GROUP_MEMBERS_DELETE,
    protocol.eventTypes.CHAT_GROUP_MEMBER_STATUS_UPDATE
  ];
  const eventTypes = subscribeAllKnownEvents
    ? [...new Set(knownEventTypes)]
    : [2, 3, 4];
  const payload = {
    msg_type: 5,
    events: eventTypes.map((eventType) => ({ event_type: eventType, subscribe: true }))
  };

  if (!subscribeAllKnownEvents && shouldSubscribeToIndividualVideoEvents(conn, mediaTypesFlag)) {
    payload.events.push(
      { event_type: 5, subscribe: true }, // SHARING_START
      { event_type: 6, subscribe: true }, // SHARING_STOP
      { event_type: protocol.eventTypes.PARTICIPANT_VIDEO_ON, subscribe: true },
      { event_type: protocol.eventTypes.PARTICIPANT_VIDEO_OFF, subscribe: true }
    );
  }

  if (!subscribeAllKnownEvents && shouldSubscribeToChatGroupEvents(mediaTypesFlag)) {
    payload.events.push(
      { event_type: protocol.eventTypes.CHAT_GROUP_CREATE, subscribe: true },
      { event_type: protocol.eventTypes.CHAT_GROUP_DELETE, subscribe: true },
      { event_type: protocol.eventTypes.CHAT_GROUP_MEMBERS_ADD, subscribe: true },
      { event_type: protocol.eventTypes.CHAT_GROUP_MEMBERS_DELETE, subscribe: true },
      { event_type: protocol.eventTypes.CHAT_GROUP_MEMBER_STATUS_UPDATE, subscribe: true }
    );
  }

  return payload;
}

export function sendDeferredEventSubscriptions(conn, signalingWs, meetingUuid, streamId) {
  if (!conn.pendingEventSubscriptionPayload || conn.eventSubscriptionsSent) {
    return;
  }

  FileLogger.log(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] Subscribing to events`);
  signalingWs.send(JSON.stringify(conn.pendingEventSubscriptionPayload));
  conn.eventSubscriptionsSent = true;
}

/**
 * Handle signaling socket messages
 * Uses SPLIT mode only - each media type gets its own WebSocket connection
 */
export function handleSignalingMessage(data, meetingUuid, streamId, signalingWs, conn, emit, mediaTypesFlag, clientId, clientSecret) {
  const protocol = getProtocolDefinitions(conn.config);

  let msg;
  try {
    msg = JSON.parse(data.toString());
    
  } catch (err) {
    FileLogger.warn(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] Invalid JSON message: ${data.toString()}`);
    return;
  }

  // The Phone event reference shows msg_type as the string "EVENT_UPDATE";
  // normalize it to the integer used by the universal protocol.
  if (msg.msg_type === 'EVENT_UPDATE') msg.msg_type = 6;

  switch (msg.msg_type) {
    case 2: // SIGNALING_HAND_SHAKE_RESP
      {
      const isDuplicateSignalRequest = String(msg.reason || '').toLowerCase().includes('duplicate signal request');
      FileLogger.log(
        `[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] Handshake response for ${conn.rtmsType} ${meetingUuid}: status=${msg.status_code} (${getRtmsStatusCode(msg.status_code)})`
      );
      conn._signalingHandshakeInFlight = false;
      if (conn._signalingConnectSocket === signalingWs) {
        conn._signalingConnectLocked = false;
        conn._signalingConnectSocket = null;
      }
      
      if (msg.status_code === 0) {
        conn.hasConnectedSignaling = true;
        conn.signalingStatus8Failures = 0;
        conn._duplicateSignalRetryCount = 0;
        if (conn._duplicateSignalRetryTimer) {
          clearTimeout(conn._duplicateSignalRetryTimer);
          conn._duplicateSignalRetryTimer = null;
        }
        const mediaUrl = getPreferredMediaUrl(conn.rtmsType, msg.media_server?.server_urls);
        let countryCode = 'unknown';
        if (mediaUrl) {
          try {
            const hostname = new URL(mediaUrl).hostname;
            countryCode = hostname.split('.').slice(-3, -2)[0] || 'unknown';
          } catch (error) {
            FileLogger.warn(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] Failed to parse media URL hostname: ${error.message}`);
          }
        }
        FileLogger.log(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] Handshake OK. Media URL: ${mediaUrl} (Server: ${countryCode.toUpperCase()})`);
        conn.signaling.state = 'ready';

        // Initialize media connections
        if (!conn.media) conn.media = {};
        
        // Calculate effective flags based on what's available
        const effectiveFlags = RTMSFlagHelper.calculateEffectiveFlags(mediaTypesFlag, msg.media_server?.server_urls);
        
        FileLogger.log(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] Requested media: ${mediaTypesFlag}, available: ${effectiveFlags}`);
        
        // One concrete media type per data socket and handshake.
        for (const [type, flag] of Object.entries(TYPE_FLAGS)) {
          if (effectiveFlags & flag) {
            const typeUrl = getPreferredMediaUrl(conn.rtmsType, msg.media_server?.server_urls, type);
            if (!typeUrl) {
              FileLogger.warn(
                `[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] No media URL returned for requested type ${type}`
              );
              continue;
            }
            FileLogger.log(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] Connecting ${type} media socket`);
            connectToMediaWebSocket(
              typeUrl,
              meetingUuid,
              streamId,
              signalingWs,
              conn,
              clientId,
              clientSecret,
              type,
              flag,
              emit
            );
          }
        }

        // Zoom Phone delivers call events (event_code 3000-3003) without a
        // subscription, and V2 rejects legacy event_type subscriptions.
        if (conn.rtmsType === 'phone') {
          conn.pendingEventSubscriptionPayload = null;
          conn.eventSubscriptionsSent = true;
        } else {
          conn.pendingEventSubscriptionPayload = buildEventSubscriptionPayload(conn, mediaTypesFlag);
          conn.eventSubscriptionsSent = false;
        }
        if (conn.rtmsType === 'phone') {
          // No event subscription to send for Phone streams.
        } else if (shouldSubscribeToIndividualVideoEvents(conn, mediaTypesFlag)) {
          FileLogger.log(
            `[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] Deferring event subscription until individual video stream is active`
          );
        } else {
          sendDeferredEventSubscriptions(conn, signalingWs, meetingUuid, streamId);
        }

      } else {
        if (isDuplicateSignalRequest && conn.shouldReconnect) {
          if (conn._duplicateSignalRetryCount < MAX_DUPLICATE_SIGNAL_RETRIES) {
            const delay = INITIAL_DUPLICATE_SIGNAL_RETRY_DELAY_MS * (2 ** conn._duplicateSignalRetryCount);
            conn._duplicateSignalRetryCount += 1;
            if (conn._duplicateSignalRetryTimer) {
              clearTimeout(conn._duplicateSignalRetryTimer);
            }
            conn._suppressNextSignalingCloseReconnect = signalingWs;
            conn._duplicateSignalRetryTimer = setTimeout(() => {
              conn._duplicateSignalRetryTimer = null;
              if (conn.shouldReconnect && typeof conn.connect === 'function') {
                conn.connect();
              }
            }, delay);
            FileLogger.warn(
              `[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] Duplicate signal request (status ${msg.status_code}), retrying in ${delay}ms`
            );
            if (signalingWs.readyState === WebSocket.OPEN || signalingWs.readyState === WebSocket.CONNECTING) {
              signalingWs.close();
            }
            break;
          }

          FileLogger.error(
            `[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] Duplicate signal retries exhausted (status ${msg.status_code})`
          );
        }

        if (msg.status_code === 8 && !conn.hasConnectedSignaling) {
          conn.signalingStatus8Failures = (conn.signalingStatus8Failures || 0) + 1;

          if (conn.signalingStatus8Failures < 3) {
            FileLogger.warn(
              `[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] Initial signaling handshake rejected with status 8; treating as transient startup rejection and waiting for reconnect (attempt ${conn.signalingStatus8Failures}).`
            );
            break;
          }
        }

        // Handshake failed - emit RTMSError
        const error = RTMSError.fromZoomStatus(msg.status_code, {
          meetingId: meetingUuid,
          streamId
        });
        FileLogger.error(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] ${error.toShortString()}`);

        if (['auth', 'security', 'request', 'meeting', 'stream'].includes(error.category)) {
          conn.shouldReconnect = false;
          FileLogger.warn(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] Disabling reconnect for non-retryable status ${msg.status_code}`);
        }
        
        // Emit error event for application handling
        emit('error', error);
      }
      break;
      }

    case 6: // Events
      if (msg.event && msg.event.event_code != null && msg.event.event_type == null) {
        handleEventCode(msg, meetingUuid, streamId, conn, emit);
      } else if (msg.event) {
        switch (msg.event.event_type) {
          case 0: // UNDEFINED
            FileLogger.log(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] UNDEFINED event`);
            break;

          case 1: // FIRST_PACKET_TIMESTAMP
            FileLogger.log(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] FIRST_PACKET_TIMESTAMP: ${msg.event.timestamp}`);
            conn.setFirstPacketTimestamp(msg.event.timestamp);
            break;

          case 2: // ACTIVE_SPEAKER_CHANGE
            FileLogger.debug(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] ACTIVE_SPEAKER: ${msg.event.user_name} (ID: ${msg.event.user_id})`);
            break;

          case 3: // PARTICIPANT_JOIN
            if (msg.event.participants && Array.isArray(msg.event.participants)) {
              msg.event.participants.forEach(p => {
                FileLogger.log(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] JOIN: ${p.user_name || 'Unknown'}`);
              });
            } else {
              FileLogger.log(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] JOIN: ${msg.event.user_name || 'Unknown'}`);
            }
            break;

          case 4: // PARTICIPANT_LEAVE
            if (msg.event.participants && Array.isArray(msg.event.participants)) {
              msg.event.participants.forEach(p => {
                FileLogger.log(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] LEAVE: ${p.user_name || 'Unknown'}`);
              });
            } else {
              FileLogger.log(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] LEAVE: ${msg.event.user_name || 'Unknown'}`);
            }
            {
              const removedParticipants = removeVideoParticipants(conn, getVideoParticipants(msg.event));
              if (removedParticipants.length > 0) {
                emitVideoParticipantSnapshot('video_on_participants_changed', removedParticipants, msg, meetingUuid, streamId, conn, emit);
              }
            }
            break;

          case 5: // SHARING_START
            FileLogger.log(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] SHARING_START`);
            break;

          case 6: // SHARING_STOP
            FileLogger.log(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] SHARING_STOP`);
            break;

          case 7: // MEDIA_CONNECTION_INTERRUPTED
            FileLogger.log(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] MEDIA_CONNECTION_INTERRUPTED`);
            emit('media_connection_interrupted', {
              type: 'media_connection_interrupted',
              data: msg.event,
              rtmsId: meetingUuid,
              meetingId: meetingUuid,
              streamId,
              productType: conn.rtmsType || 'meeting',
              timestamp: msg.event.timestamp || Date.now()
            });
            break;

          case protocol.eventTypes.PARTICIPANT_VIDEO_ON: {
            const participants = getVideoParticipants(msg.event);
            upsertVideoParticipants(conn, participants);
            FileLogger.log(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] PARTICIPANT_VIDEO_ON: ${participants.map((participant) => participant.userId).join(', ')}`);
            emitVideoParticipantSnapshot('participant_video_on', participants, msg, meetingUuid, streamId, conn, emit);
            emitVideoParticipantSnapshot('video_on_participants_changed', participants, msg, meetingUuid, streamId, conn, emit);
            break;
          }

          case protocol.eventTypes.PARTICIPANT_VIDEO_OFF: {
            const participants = getVideoParticipants(msg.event);
            const removedParticipants = removeVideoParticipants(conn, participants);
            FileLogger.log(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] PARTICIPANT_VIDEO_OFF: ${participants.map((participant) => participant.userId).join(', ')}`);
            emitVideoParticipantSnapshot('participant_video_off', participants, msg, meetingUuid, streamId, conn, emit);
            emitVideoParticipantSnapshot('video_on_participants_changed', removedParticipants.length > 0 ? removedParticipants : participants, msg, meetingUuid, streamId, conn, emit);
            break;
          }

          case protocol.eventTypes.CHAT_GROUP_CREATE:
            emitChatGroupEvent('chat_group_created', msg, meetingUuid, streamId, conn, emit);
            break;

          case protocol.eventTypes.CHAT_GROUP_DELETE:
            emitChatGroupEvent('chat_group_deleted', msg, meetingUuid, streamId, conn, emit);
            break;

          case protocol.eventTypes.CHAT_GROUP_MEMBERS_ADD:
            emitChatGroupEvent('chat_group_members_added', msg, meetingUuid, streamId, conn, emit);
            break;

          case protocol.eventTypes.CHAT_GROUP_MEMBERS_DELETE:
            emitChatGroupEvent('chat_group_members_removed', msg, meetingUuid, streamId, conn, emit);
            break;

          case protocol.eventTypes.CHAT_GROUP_MEMBER_STATUS_UPDATE:
            emitChatGroupEvent('chat_group_member_status_updated', msg, meetingUuid, streamId, conn, emit);
            break;

          default:
            FileLogger.log(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] Unknown event_type: ${msg.event.event_type}`);
        }
      }

      // Emit event object
      emit('event', {
        type: 'event',
        eventType: msg.event?.event_type ?? null,
        eventCode: msg.event?.event_code ?? null,
        data: msg.event,
        rtmsId: meetingUuid,
        meetingId: meetingUuid,
        streamId,
        productType: conn.rtmsType || 'meeting',
        timestamp: msg.event?.timestamp || Date.now()
      });
      break;

    case 8: // Stream State changed
      FileLogger.log(
        `[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] Stream state: ${getRtmsStreamState(msg.state)}, reason: ${msg.reason == null ? 'n/a' : getRtmsStopReason(msg.reason)}`
      );

      // Any terminated stream should stop reconnecting and clean up immediately.
      if (msg.state === 4) {
        FileLogger.log(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] Stream terminated, cleaning up local sockets`);

        if (conn) {
          conn.shouldReconnect = false;

          // Close signaling socket
          if (conn.signaling) {
            conn.signaling.state = 'closed';
            const ws = conn.signaling.socket;
            if (ws && typeof ws.close === 'function') {
              if (ws.readyState === WebSocket.CONNECTING) {
                ws.once('open', () => ws.close());
              } else {
                ws.close();
              }
            }
          }

          // Close all media sockets
          if (conn.media) {
            Object.values(conn.media).forEach(m => {
              if (!m || typeof m !== 'object') return;
              const ws = m.socket || m;
              if (ws && typeof ws.close === 'function') {
                if (ws.readyState === WebSocket.CONNECTING) {
                  ws.once('open', () => ws.close());
                } else {
                  ws.close();
                }
              }
            });
          }
        }
      }

      emit('stream_state_changed', {
        type: 'stream_state_changed',
        state: msg.state,
        reason: msg.reason ?? null,
        data: msg,
        rtmsId: meetingUuid,
        meetingId: meetingUuid,
        streamId,
        productType: conn.rtmsType || 'meeting',
        timestamp: Date.now()
      });
      break;

    case 9: // Session State Changed
      FileLogger.log(
        `[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] Session state: ${getRtmsSessionState(msg.state)}, stop_reason: ${msg.stop_reason == null ? 'n/a' : getRtmsStopReason(msg.stop_reason)}`
      );

      if (msg.state === 5 && conn) {
        FileLogger.log(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] Session stopped, disabling reconnect`);
        conn.shouldReconnect = false;
      }

      emit('session_state_changed', {
        type: 'session_state_changed',
        state: msg.state,
        stopReason: msg.stop_reason ?? null,
        data: msg,
        rtmsId: meetingUuid,
        meetingId: meetingUuid,
        streamId,
        productType: conn.rtmsType || 'meeting',
        timestamp: Date.now()
      });
      break;

    case 12: // KEEP_ALIVE_REQ
      conn.signaling.lastKeepAlive = Date.now();
      signalingWs.send(JSON.stringify({
        msg_type: 13,
        timestamp: msg.timestamp
      }));
      break;

    case protocol.messageTypes.VIDEO_SUBSCRIPTION_RESP: {
      const success = msg.status_code === 0;
      const subscribed = msg.subscribe !== false;
      if (success) {
        conn.currentVideoSubscriptionUserId = subscribed ? msg.user_id : null;
      }

      emit('video_subscription_response', {
        type: 'video_subscription_response',
        userId: msg.user_id ?? null,
        subscribed,
        statusCode: msg.status_code,
        success,
        reason: msg.reason ?? null,
        currentVideoSubscriptionUserId: conn.currentVideoSubscriptionUserId ?? null,
        data: msg,
        rtmsId: meetingUuid,
        meetingId: meetingUuid,
        streamId,
        productType: conn.rtmsType || 'meeting',
        timestamp: msg.timestamp || Date.now()
      });
      break;
    }

    case protocol.messageTypes.STREAM_CLOSE_RESP:
      emit('stream_close_response', {
        type: 'stream_close_response',
        statusCode: msg.status_code,
        success: msg.status_code === 0,
        reason: msg.reason ?? null,
        data: msg,
        rtmsId: meetingUuid,
        meetingId: meetingUuid,
        streamId,
        productType: conn.rtmsType || 'meeting',
        timestamp: msg.timestamp || Date.now()
      });
      break;

    default:
      FileLogger.log(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] Unhandled msg_type: ${msg.msg_type}`);
      break;
  }
}
