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

export function handleSignalingMessage(data, meetingUuid, streamId, signalingWs, conn, emit, mediaSocketConnectionMode, mediaTypesFlag, clientId, clientSecret) {
 
  let msg;
  try {
    msg = JSON.parse(data.toString());
    
  } catch (err) {
    FileLogger.warn(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] Invalid JSON message: ${data.toString()}`);
    return;
  }

  switch (msg.msg_type) {
    case 2: // SIGNALING_HAND_SHAKE_RESP
      FileLogger.log(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] Processing handshake response (case 2) for ${conn.rtmsType} ${meetingUuid}. Handshake response: ${JSON.stringify(msg, null, 2)}`);
      if (msg.status_code === 0) {
        const mediaUrl = msg.media_server?.server_urls?.all;
        const hostname = new URL(mediaUrl).hostname;
        const countryCode = hostname.split('.').slice(-3, -2)[0] || 'unknown';
        FileLogger.log(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] Handshake OK. Media URL: ${mediaUrl} (Server location: ${countryCode.toUpperCase()})`);
        conn.signaling.state = 'ready';
        FileLogger.log(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] Connection state updated to 'ready' for ${conn.rtmsType} ${meetingUuid}`);


        FileLogger.log(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] Initiating media WebSocket connection (mode: ${mediaSocketConnectionMode}, flags: ${mediaTypesFlag})`);
        if (!conn.media) conn.media = {};
        if (mediaSocketConnectionMode === 'unified') {
          connectToMediaWebSocket(
            mediaUrl,
            meetingUuid,
            streamId,
            signalingWs,
            conn,
            clientId,
            clientSecret,
            'unified',
            mediaTypesFlag,
            emit
          );
        } else {
          if (!conn.media) conn.media = {};
          
          //this is necessary when some features are not available yet
          const effectiveFlags = RTMSFlagHelper.calculateEffectiveFlags(mediaTypesFlag, msg.media_server?.server_urls);
          
          FileLogger.log(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] Debug: mediaTypesFlag = ${mediaTypesFlag}, effectiveFlags = ${effectiveFlags}`);
          for (const [type, flag] of Object.entries(TYPE_FLAGS)) {
            FileLogger.log(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] Debug: Checking ${type} (flag ${flag}). Result: ${effectiveFlags & flag}`);
            if (effectiveFlags & flag) {
              const typeUrl = msg.media_server?.server_urls?.[type] || mediaUrl;
              FileLogger.log(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] Connecting ${type} media WS (flag ${flag})`);
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

        // Send event subscription payload (msg_type 5)
        const subscribePayload = {
          msg_type: 5,
          events: [
            { event_type: 2, subscribe: true }, // ACTIVE_SPEAKER_CHANGE
            { event_type: 3, subscribe: true }, // PARTICIPANT_JOIN
            { event_type: 4, subscribe: true }  // PARTICIPANT_LEAVE
          ]
        };

        FileLogger.log(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] Sending event subscription payload`);
        signalingWs.send(JSON.stringify(subscribePayload));
       

      } else {
        FileLogger.warn(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] Handshake failed: status_code = ${msg.status_code}. ${getRtmsStatusCode(msg.status_code)}. ${getRtmsStopReason(msg.reason)}`);
      }
      break;

    case 6: // Events
      FileLogger.log(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] Processing event message (case 6) for ${conn.rtmsType} ${meetingUuid}. Message: ${JSON.stringify(msg, null, 2)}`);
      if (msg.event) {
       
        switch (msg.event.event_type) {
          case 0: // UNDEFINED
            FileLogger.log(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] UNDEFINED event received`);
            break;

          case 1: // FIRST_PACKET_TIMESTAMP
            FileLogger.log(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] FIRST_PACKET_TIMESTAMP — first media packet at ${msg.event.timestamp}`);
            conn.setFirstPacketTimestamp(msg.event.timestamp);
            break;

          case 2: // ACTIVE_SPEAKER_CHANGE
            FileLogger.log(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] ACTIVE_SPEAKER_CHANGE — ${msg.event.user_name} (ID: ${msg.event.user_id}) is now speaking`);
            break;

          case 3: // PARTICIPANT_JOIN
            if (msg.event.participants && Array.isArray(msg.event.participants)) {
              msg.event.participants.forEach(p => {
                FileLogger.log(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] PARTICIPANT_JOIN — ${p.user_name || 'Unknown'} (ID: ${p.user_id || 'Unknown'}) joined`);
              });
            } else {
              FileLogger.log(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] PARTICIPANT_JOIN — ${msg.event.user_name || 'Unknown'} (ID: ${msg.event.user_id || 'Unknown'}) joined`);
            }
            break;

          case 4: // PARTICIPANT_LEAVE
            if (msg.event.participants && Array.isArray(msg.event.participants)) {
              msg.event.participants.forEach(p => {
                FileLogger.log(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] PARTICIPANT_LEAVE — ${p.user_name || 'Unknown'} (ID: ${p.user_id || 'Unknown'}) left`);
              });
            } else {
              FileLogger.log(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] PARTICIPANT_LEAVE — ${msg.event.user_name || 'Unknown'} (ID: ${msg.event.user_id || 'Unknown'}) left`);
            }
            break;

          case 5: // SHARING_START
            FileLogger.log(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] SHARING_START — Sharing has started in the meeting`);
            break;

          case 6: // SHARING_STOP
            FileLogger.log(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] SHARING_STOP — Sharing has stopped in the meeting`);
            break;

          case 7: // MEDIA_CONNECTION_INTERRUPTED
            FileLogger.log(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] MEDIA_CONNECTION_INTERRUPTED — A media type connection was interrupted`);
            break;

          default:
            FileLogger.log(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] Unknown event_type: ${msg.event.event_type}`);
        }
      } else {
        FileLogger.log(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] Event message received but no event data`);
      }

      emit('event', msg.event, meetingUuid, streamId, conn.rtmsType || 'meeting');
      break;

    case 8: // Stream State changed
      FileLogger.log(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] Processing stream state change (case 8) for ${conn.rtmsType} ${meetingUuid}. Message: ${JSON.stringify(msg, null, 2)}`);

      if ('reason' in msg) {
        FileLogger.log(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] Stream state change reason: ${msg.reason}, ${getRtmsStopReason(msg.reason)}`);
      }

      if ('state' in msg) {
        FileLogger.log(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] Stream state: ${msg.state},  ${getRtmsStreamState(msg.state)}`);
      }
      //meeting ended
      if (msg.reason === 6 && msg.state === 4) {
        FileLogger.log(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] Meeting ended detected, cleaning up connections for ${conn.rtmsType} ${meetingUuid}`);

        if (conn) {
          conn.shouldReconnect = false;
          FileLogger.log(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] Disabled reconnection for ${conn.rtmsType} ${meetingUuid}`);

          // Explicitly update states
          if (conn.signaling) {
            conn.signaling.state = 'closed';
            const ws = conn.signaling.socket;
            if (ws && typeof ws.close === 'function') {
              FileLogger.log(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] Closing signaling WebSocket for ${conn.rtmsType} ${meetingUuid}`);
              if (ws.readyState === WebSocket.CONNECTING) {
                ws.once('open', () => ws.close());
              } else {
                ws.close();
              }
            }
          }

          if (conn.media) {
            Object.values(conn.media).forEach(m => {
              if (!m || typeof m !== 'object') return;
              const ws = m.socket || m;
              if (ws && typeof ws.close === 'function') {
                FileLogger.log(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] Closing media WebSocket for ${conn.rtmsType} ${meetingUuid}`);
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

      emit('stream_state_changed', msg, meetingUuid, streamId, conn.rtmsType || 'meeting');
      break;

    case 9: // Session State Changed
      FileLogger.log(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] Processing session state change (case 9) for ${conn.rtmsType} ${meetingUuid}. Message: ${JSON.stringify(msg, null, 2)}`);
      if ('stop_reason' in msg) {
        FileLogger.log(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] Session stop reason: ${msg.stop_reason}, ${getRtmsStopReason(msg.reason)}`);
      }

      if ('state' in msg) {
        FileLogger.log(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] Session state: ${msg.state}, ${getRtmsSessionState(msg.state)}`);
      }

      emit('session_state_changed', msg, meetingUuid, streamId, conn.rtmsType || 'meeting');
      break;

    case 12: // KEEP_ALIVE_REQ
      FileLogger.log(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] Case 12, Responding to KEEP_ALIVE_REQ`);
      conn.signaling.lastKeepAlive = Date.now();

      const keepAliveResponse = {
        msg_type: 13,
        timestamp: msg.timestamp
      };
     
      signalingWs.send(JSON.stringify(keepAliveResponse));
    
      break;

    default:
      FileLogger.log(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] Unhandled msg_type: ${msg.msg_type}`);
      break;
  }
}
