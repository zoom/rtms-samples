import WebSocket from 'ws';
import { generateSignature } from './utils/signature.js';
import { connectToMediaWebSocket } from './mediaSocket.js';
import {
  logHandshakeResponse,
  logRtmsSessionState,
  logRtmsStreamState,
  logRtmsStopReason,
  logRtmsStatusCode
} from './utils/rtmsEventLookup.js';


export function connectToSignalingWebSocket(
  meetingUuid,
  streamId,
  serverUrls,
  activeConnections,
  clientId,
  clientSecret
) {
  console.log(`[Signaling] Starting connection function for meeting ${meetingUuid}`);
  console.log(`[Signaling] Stream ID: ${streamId}, Server URL: ${serverUrls}`);
  console.log(`[Signaling] Connecting for meeting ${meetingUuid}`);


  if (!serverUrls || typeof serverUrls !== 'string' || !serverUrls.startsWith('ws')) {
    console.error(`[Signaling] ❌ Invalid WebSocket URL:`, serverUrls);
    console.error(`[Signaling] URL validation failed - URL is null/undefined or doesn't start with ws/wss`);

    // Set shouldReconnect to false to prevent retry loop
    if (activeConnections.has(meetingUuid)) {
      console.error(`[Signaling] MeetingUUID found in activeConnections map`);
      const conn = activeConnections.get(meetingUuid);
      conn.shouldReconnect = false;
      console.error(`[Signaling] MeetingUUID found in activeConnections map. disabling reconnection`);
    }
    else{
      console.error(`[Signaling] MeetingUUID not found in activeConnections map`);
    }

    return;
  }



  let signalingWs;
  try {
    console.log(`[Signaling] Creating WebSocket instance for ${serverUrls}`);
    signalingWs = new WebSocket(serverUrls);
    console.log(`[Signaling] WebSocket instance created successfully`);
  } catch (err) {
    console.error(`[Signaling] ❌ Failed to create WebSocket instance: ${err.message}`);
    return;
  }

  // Set up or refresh connection state
  if (!activeConnections.has(meetingUuid)) {
    console.log(`[Signaling] Creating new connection entry for meeting ${meetingUuid}`);
    activeConnections.set(meetingUuid, {
      meetingUuid,
      streamId,
      serverUrls,
      shouldReconnect: true,
      signaling: { socket: null, state: 'connecting', lastKeepAlive: null },
      media: { socket: null, state: 'idle', lastKeepAlive: null },
    });
  } else {
    console.log(`[Signaling] Refreshing existing connection entry for meeting ${meetingUuid}`);
  }

  const conn = activeConnections.get(meetingUuid);
  conn.signaling.socket = signalingWs;
  conn.signaling.state = 'connecting';
  console.log(`[Signaling] Connection state set to 'connecting' for ${meetingUuid}`);

  signalingWs.on('open', () => {
    
    try {
      console.log(`[Signaling] WebSocket opened successfully for ${meetingUuid}`);
      if (!conn.shouldReconnect) {
        console.warn(`[Signaling] Aborting open: RTMS stopped for ${meetingUuid}`);
        signalingWs.close();
        return;
      }

      console.log(`[Signaling] Generating signature for handshake`);
      const signature = generateSignature(meetingUuid, streamId, clientId, clientSecret);
      console.log(`[Signaling] Signature generated successfully`);

      //     {
      //   "msg_type": 1,
      //   "protocol_version": 1,   //WebSockets, RTMP, UDP, or WebRTC. WebSockets only for developer preview.
      //   "sequence": 0,
      //   "meeting_uuid": "4nYtdqLVTVqGJ+QB62ED7Q==",
      //   "rtms_stream_id": "03db704592624398931a588dd78200cb",
      //   "signature": "xxxxxxxxxx"
      // }

      const handshakeMsg = {
        msg_type: 1,
        meeting_uuid: meetingUuid,
        rtms_stream_id: streamId,
        signature,
      };

      console.log(`[Signaling] Sending handshake for ${meetingUuid}`);
      console.log(`[Signaling] Handshake payload:`, JSON.stringify(handshakeMsg, null, 2));
      signalingWs.send(JSON.stringify(handshakeMsg));
      conn.signaling.state = 'authenticated';
      console.log(`[Signaling] Connection state updated to 'authenticated' for ${meetingUuid}`);
    } catch (err) {
      console.error(`[Signaling] Error in WebSocket open handler for ${meetingUuid}: ${err.message}`);
      console.error(`[Signaling] Open handler error details:`, err);
      conn.signaling.state = 'error';
      signalingWs.close();
    }
  });
  signalingWs.on('message', (data) => {
    console.log(`[Signaling] Received message for ${meetingUuid}`);
    let msg;
    try {
      msg = JSON.parse(data.toString());
      console.log(`[Signaling] Parsed message type: ${msg.msg_type}`);
    } catch (err) {
      console.warn(`[Signaling] Invalid JSON message:`, data.toString());
      return;
    }

    switch (msg.msg_type) {

      // {
      //   "msg_type": 2,
      //   "protocol_version": 1,
      //   "sequence": 0,
      //   "status_code": 0,
      //   "reason": "",
      //   "media_server": {
      //     "server_urls": {
      //       "audio": "wss://0.0.0.0:443",
      //       "video": "wss://0.0.0.0:443",
      //       "transcript": "wss://0.0.0.0:443",
      //       "all": "wss://0.0.0.0:443"
      //     }
      //   }
      // }

      case 2: // SIGNALING_HAND_SHAKE_RESP
        console.log(`[Signaling] Processing handshake response (case 2) for ${meetingUuid}`);
        console.log(`[Signaling] Handshake response:`, JSON.stringify(msg, null, 2));
        if (msg.status_code === 0) {
          const mediaUrl = msg.media_server?.server_urls?.all;
          console.log(`[Signaling] Handshake OK. Media URL: ${mediaUrl}`);
          conn.signaling.state = 'ready';
          console.log(`[Signaling] Connection state updated to 'ready' for ${meetingUuid}`);

          console.log(`[Signaling] Initiating media WebSocket connection`);
          connectToMediaWebSocket(
            mediaUrl,
            meetingUuid,
            streamId,
            signalingWs,
            conn,
            clientId,
            clientSecret,
            activeConnections
          );

          // Send event subscription payload (msg_type 5)
          // There is no response for this, do take note
          const subscribePayload = {
            msg_type: 5,
            events: [
              { event_type: 2, subscribe: true }, // ACTIVE_SPEAKER_CHANGE
              { event_type: 3, subscribe: true }, // PARTICIPANT_JOIN
              { event_type: 4, subscribe: true }  // PARTICIPANT_LEAVE
            ]
          };

          console.log(`[Signaling] Sending event subscription payload`);
          signalingWs.send(JSON.stringify(subscribePayload));
          console.log(`[Signaling] Event subscription payload sent successfully`);

        } else {
          console.warn(`[Signaling] Handshake failed: status_code = ${msg.status_code}`);
          logRtmsStatusCode(msg.status_code);
          logRtmsStopReason(msg.reason);
        }
        break;

      case 6: // first timestamp from signaling server
        console.log(`[Signaling] Processing event message (case 6) for ${meetingUuid}`);
        console.log(`[Signaling] Event message:`, JSON.stringify(msg, null, 2));
        if (msg.event) {
          console.log(`[Signaling] Event type: ${msg.event.event_type}`);
          switch (msg.event.event_type) {
            case 0: // UNDEFINED
              console.log(`[Event] UNDEFINED event received`);
              break;

            case 1: // FIRST_PACKET_TIMESTAMP
              console.log(`[Event] FIRST_PACKET_TIMESTAMP — first media packet at ${msg.event.timestamp}`);
              break;

            case 2: // ACTIVE_SPEAKER_CHANGE
              console.log(`[Event] ACTIVE_SPEAKER_CHANGE — ${msg.event.user_name} (ID: ${msg.event.user_id}) is now speaking`);
              break;

            case 3: // PARTICIPANT_JOIN
              console.log(`[Event] PARTICIPANT_JOIN — ${msg.event.user_name} (ID: ${msg.event.user_id}) joined`);
              break;

            case 4: // PARTICIPANT_LEAVE
              console.log(`[Event] PARTICIPANT_LEAVE — ${msg.event.user_name} (ID: ${msg.event.user_id}) left`);
              break;

            default:
              console.log(`[Event] Unknown event_type: ${msg.event.event_type}`);
          }
        } else {
          console.log(`[Signaling] Event message received but no event data`);
        }

        break;

      case 8: // Stream State changed
        console.log(`[Signaling] Processing stream state change (case 8) for ${meetingUuid}`);
        console.log(`[Signaling] Stream state message:`, JSON.stringify(msg, null, 2));

        if ('reason' in msg) {
          console.log(`[Signaling] Stream state change reason: ${msg.reason}`);
          logRtmsStopReason(msg.reason);
        }

        if ('state' in msg) {
          console.log(`[Signaling] Stream state: ${msg.state}`);
          logRtmsStreamState(msg.state);
        }
        //meeting ended
        if (msg.reason === 6 && msg.state === 4) {
          console.log(`[Signaling] Meeting ended detected, cleaning up connections for ${meetingUuid}`);

          if (conn) {
            conn.shouldReconnect = false;
            console.log(`[Signaling] Disabled reconnection for ${meetingUuid}`);

            // Explicitly update states
            if (conn.signaling) {
              conn.signaling.state = 'closed';
              const ws = conn.signaling.socket;
              if (ws && typeof ws.close === 'function') {
                console.log(`[Signaling] Closing signaling WebSocket for ${meetingUuid}`);
                if (ws.readyState === WebSocket.CONNECTING) {
                  ws.once('open', () => ws.close());
                } else {
                  ws.close();
                }
              }
            }

            if (conn.media) {
              conn.media.state = 'closed';
              const ws = conn.media.socket;
              if (ws && typeof ws.close === 'function') {
                console.log(`[Signaling] Closing media WebSocket for ${meetingUuid}`);
                if (ws.readyState === WebSocket.CONNECTING) {
                  ws.once('open', () => ws.close());
                } else {
                  ws.close();
                }
              }
            }

            // Finally, delete from the map
            console.log(`[Signaling] Removing connection entry for ${meetingUuid}`);
            activeConnections.delete(meetingUuid);
          }

        }

        break;
      case 9: // Session State Changed
        console.log(`[Signaling] Processing session state change (case 9) for ${meetingUuid}`);
        console.log(`[Signaling] Session state message:`, JSON.stringify(msg, null, 2));
        if ('stop_reason' in msg) {
          console.log(`[Signaling] Session stop reason: ${msg.stop_reason}`);
          logRtmsStopReason(msg.reason);
        }

        if ('state' in msg) {
          console.log(`[Signaling] Session state: ${msg.state}`);
          logRtmsSessionState(msg.state);
        }

        break;
      case 12: // KEEP_ALIVE_REQ
        console.log(`[Signaling] Processing keep-alive request (case 12) for ${meetingUuid}`);
        console.log(`[Signaling] Keep-alive timestamp: ${msg.timestamp}`);
        conn.signaling.lastKeepAlive = Date.now();
        console.log(`[Signaling] Updated last keep-alive time for ${meetingUuid}`);
        const keepAliveResponse = {
          msg_type: 13,
          timestamp: msg.timestamp
        };
        console.log(`[Signaling] Sending keep-alive response:`, JSON.stringify(keepAliveResponse, null, 2));
        signalingWs.send(JSON.stringify(keepAliveResponse));
        console.log(`[Signaling] Keep-alive response sent for ${meetingUuid}`);
        break;

      default:
        console.log(`[Signaling] Unhandled msg_type: ${msg.msg_type}`);
        break;
    }
  });


  signalingWs.on('close', (code, reason) => {
    console.log(`[Signaling] WebSocket closed for ${meetingUuid}, code: ${code}, reason: ${reason}`);

    const conn = activeConnections.get(meetingUuid);
    if (conn) {
      conn.signaling.state = 'closed';
      console.log(`[Signaling] Connection state updated to 'closed' for ${meetingUuid}`);

      if (conn.shouldReconnect) {
        console.log(`[Signaling] Will reconnect for ${meetingUuid} in 3s...`);
        setTimeout(() => {
          if (conn.shouldReconnect) {
            console.log(`[Signaling] Starting reconnection for ${meetingUuid}`);
            connectToSignalingWebSocket(
              meetingUuid,
              streamId,
              conn.serverUrls, // Use serverUrls from conn instead of signaling.url
              activeConnections,
              clientId,
              clientSecret
            );
          } else {
            console.log(`[Signaling] Reconnection cancelled for ${meetingUuid}`);
          }
        }, 3000);
      } else {
        console.log(`[Signaling] Not reconnecting — RTMS was stopped for ${meetingUuid}.`);
      }
    } else {
      console.log(`[Signaling] No connection entry found for ${meetingUuid} during close`);
    }
  });


  signalingWs.on('error', (err) => {
    console.error(`[Signaling] WebSocket error for ${meetingUuid}: ${err.message}`);
    console.error(`[Signaling] Error details:`, err);
    if (conn) {
      conn.signaling.state = 'error';
      console.log(`[Signaling] Connection state updated to 'error' for ${meetingUuid}`);
    }
  });
}
