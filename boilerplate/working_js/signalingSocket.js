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
  console.log(`[Signaling] Connecting for meeting ${meetingUuid}`);


  if (!serverUrls || typeof serverUrls !== 'string' || !serverUrls.startsWith('ws')) {
    console.error(`[Signaling] ❌ Invalid WebSocket URL:`, serverUrls);

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
    signalingWs = new WebSocket(serverUrls);
  } catch (err) {
    console.error(`[Signaling] ❌ Failed to connect WebSocket: ${err.message}`);
    return;
  }

  // Set up or refresh connection state
  if (!activeConnections.has(meetingUuid)) {
    activeConnections.set(meetingUuid, {
      meetingUuid,
      streamId,
      serverUrls,
      shouldReconnect: true,
      signaling: { socket: null, state: 'connecting', lastKeepAlive: null },
      media: { socket: null, state: 'idle', lastKeepAlive: null },
    });
  }

  const conn = activeConnections.get(meetingUuid);
  conn.signaling.socket = signalingWs;
  conn.signaling.state = 'connecting';

  signalingWs.on('open', () => {
    if (!conn.shouldReconnect) {
      console.warn(`[Signaling] Aborting open: RTMS stopped for ${meetingUuid}`);
      signalingWs.close();
      return;
    }

    const signature = generateSignature(meetingUuid, streamId, clientId, clientSecret);

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
    signalingWs.send(JSON.stringify(handshakeMsg));
    conn.signaling.state = 'authenticated';
  });
  signalingWs.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
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
        console.log("case 2");
        if (msg.status_code === 0) {
          const mediaUrl = msg.media_server?.server_urls?.all;
          console.log(`[Signaling] Handshake OK. Media URL: ${mediaUrl}`);
          conn.signaling.state = 'ready';

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

          signalingWs.send(JSON.stringify(subscribePayload));
          console.log(`[Signaling] Sent event subscription payload`);

        } else {
          console.warn(`[Signaling] Handshake failed: status_code = ${msg.status_code}`);
          logRtmsStatusCode(msg.status_code);
          logRtmsStopReason(msg.reason);
        }
        break;

      case 6: // first timestamp from signaling server
        console.log("case 6");
        console.log(msg);
        if (msg.event) {
          switch (msg.event.event_type) {
            case 0: // UNDEFINED
              console.log('[Event] UNDEFINED');
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
        }

        break;

      case 8: // Stream State changed
        console.log("case 8");
        console.log(msg);

        if ('reason' in msg) {
          logRtmsStopReason(msg.reason);
        }

        if ('state' in msg) {
          logRtmsStreamState(msg.state);
        }
        //meeting ended
        if (msg.reason === 6 && msg.state === 4) {

          if (conn) {
            conn.shouldReconnect = false;

            // Explicitly update states
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

            if (conn.media) {
              conn.media.state = 'closed';
              const ws = conn.media.socket;
              if (ws && typeof ws.close === 'function') {
                if (ws.readyState === WebSocket.CONNECTING) {
                  ws.once('open', () => ws.close());
                } else {
                  ws.close();
                }
              }
            }

            // Finally, delete from the map
            activeConnections.delete(meetingUuid);
          }

        }

        break;
      case 9: // Session State Changed
        console.log("case 9");
        console.log(msg);
        if ('stop_reason' in msg) {
          logRtmsStopReason(msg.reason);
        }

        if ('state' in msg) {
          logRtmsSessionState(msg.state);
        }

        break;
      case 12: // KEEP_ALIVE_REQ
        console.log("case 12");
        conn.signaling.lastKeepAlive = Date.now();
        console.log(msg.timestamp);
        signalingWs.send(JSON.stringify({
          msg_type: 13,
          timestamp: msg.timestamp
        }));
        break;

      default:
        console.log(`[Signaling] Unhandled msg_type: ${msg.msg_type}`);
        break;
    }
  });


  signalingWs.on('close', () => {
    console.log(`[Signaling] Closed for ${meetingUuid}`);

    const conn = activeConnections.get(meetingUuid);
    if (conn) {
      conn.signaling.state = 'closed';

      if (conn.shouldReconnect) {
        console.log(`[Signaling] Will reconnect for ${meetingUuid} in 3s...`);
        setTimeout(() => {
          if (conn.shouldReconnect) {
            connectToSignalingWebSocket(
              meetingUuid,
              streamId,
              conn.signaling.url,
              activeConnections,
              clientId,
              clientSecret
            );
          }
        }, 3000);
      } else {
        console.log(`[Signaling] Not reconnecting — RTMS was stopped.`);
      }
    }
  });


  signalingWs.on('error', (err) => {
    console.error(`[Signaling] Error: ${err.message}`);
    conn.signaling.state = 'error';
  });
}
