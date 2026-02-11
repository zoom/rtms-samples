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

/**
 * Handle signaling socket messages
 * Uses SPLIT mode only - each media type gets its own WebSocket connection
 */
export function handleSignalingMessage(data, meetingUuid, streamId, signalingWs, conn, emit, mediaTypesFlag, clientId, clientSecret) {
 
  let msg;
  try {
    msg = JSON.parse(data.toString());
    
  } catch (err) {
    FileLogger.warn(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] Invalid JSON message: ${data.toString()}`);
    return;
  }

  switch (msg.msg_type) {
    case 2: // SIGNALING_HAND_SHAKE_RESP
      FileLogger.log(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] Handshake response for ${conn.rtmsType} ${meetingUuid}`);
      conn._signalingHandshakeInFlight = false;
      
      if (msg.status_code === 0) {
        const mediaUrl = msg.media_server?.server_urls?.all;
        const hostname = new URL(mediaUrl).hostname;
        const countryCode = hostname.split('.').slice(-3, -2)[0] || 'unknown';
        FileLogger.log(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] Handshake OK. Media URL: ${mediaUrl} (Server: ${countryCode.toUpperCase()})`);
        conn.signaling.state = 'ready';

        // Initialize media connections
        if (!conn.media) conn.media = {};
        
        // Calculate effective flags based on what's available
        const effectiveFlags = RTMSFlagHelper.calculateEffectiveFlags(mediaTypesFlag, msg.media_server?.server_urls);
        
        FileLogger.log(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] Requested media: ${mediaTypesFlag}, available: ${effectiveFlags}`);
        
        // Check if unified mode is enabled (single socket for all media types)
        const useUnifiedMode = conn.config?.useUnifiedMediaSocket === true;
        
        if (useUnifiedMode) {
          // Unified mode: single WebSocket for all media types (better sync)
          FileLogger.log(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] Connecting unified media socket`);
          connectToMediaWebSocket(
            mediaUrl,
            meetingUuid,
            streamId,
            signalingWs,
            conn,
            clientId,
            clientSecret,
            'all',
            effectiveFlags,
            emit
          );
        } else {
          // Split mode: separate socket per media type
          for (const [type, flag] of Object.entries(TYPE_FLAGS)) {
            if (effectiveFlags & flag) {
              const typeUrl = msg.media_server?.server_urls?.[type] || mediaUrl;
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
        }

        // Subscribe to signaling events
        const subscribePayload = {
          msg_type: 5,
          events: [
            { event_type: 2, subscribe: true }, // ACTIVE_SPEAKER_CHANGE
            { event_type: 3, subscribe: true }, // PARTICIPANT_JOIN
            { event_type: 4, subscribe: true }  // PARTICIPANT_LEAVE
          ]
        };
        FileLogger.log(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] Subscribing to events`);
        signalingWs.send(JSON.stringify(subscribePayload));

      } else {
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

    case 6: // Events
      if (msg.event) {
        switch (msg.event.event_type) {
          case 0: // UNDEFINED
            FileLogger.log(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] UNDEFINED event`);
            break;

          case 1: // FIRST_PACKET_TIMESTAMP
            FileLogger.log(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] FIRST_PACKET_TIMESTAMP: ${msg.event.timestamp}`);
            conn.setFirstPacketTimestamp(msg.event.timestamp);
            break;

          case 2: // ACTIVE_SPEAKER_CHANGE
            FileLogger.log(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] ACTIVE_SPEAKER: ${msg.event.user_name} (ID: ${msg.event.user_id})`);
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
            break;

          case 5: // SHARING_START
            FileLogger.log(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] SHARING_START`);
            break;

          case 6: // SHARING_STOP
            FileLogger.log(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] SHARING_STOP`);
            break;

          case 7: // MEDIA_CONNECTION_INTERRUPTED
            FileLogger.log(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] MEDIA_CONNECTION_INTERRUPTED`);
            break;

          default:
            FileLogger.log(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] Unknown event_type: ${msg.event.event_type}`);
        }
      }

      // Emit event object
      emit('event', {
        type: 'event',
        eventType: msg.event.event_type,
        data: msg.event,
        meetingId: meetingUuid,
        streamId,
        productType: conn.rtmsType || 'meeting',
        timestamp: msg.event.timestamp || Date.now()
      });
      break;

    case 8: // Stream State changed
      FileLogger.log(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] Stream state: ${getRtmsStreamState(msg.state)}, reason: ${getRtmsStopReason(msg.reason)}`);

      // Meeting ended (reason: 6, state: 4)
      if (msg.reason === 6 && msg.state === 4) {
        FileLogger.log(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] Meeting ended, cleaning up`);

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
        reason: msg.reason,
        data: msg,
        meetingId: meetingUuid,
        streamId,
        productType: conn.rtmsType || 'meeting',
        timestamp: Date.now()
      });
      break;

    case 9: // Session State Changed
      FileLogger.log(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] Session state: ${getRtmsSessionState(msg.state)}, stop_reason: ${getRtmsStopReason(msg.stop_reason)}`);

      emit('session_state_changed', {
        type: 'session_state_changed',
        state: msg.state,
        stopReason: msg.stop_reason,
        data: msg,
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

    default:
      FileLogger.log(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] Unhandled msg_type: ${msg.msg_type}`);
      break;
  }
}
