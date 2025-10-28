import express from 'express';
import WebSocket from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import https from 'https';
import dotenv from 'dotenv';
import crypto from 'crypto';

dotenv.config();

const requiredVars = ['ZOOM_CLIENT_ID', 'ZOOM_CLIENT_SECRET'];

for (const key of requiredVars) {
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}

const config = {
  port: process.env.PORT || 3000,

  mode: process.env.MODE || 'webhook',
  zoomWSURLForEvents: process.env.zoomWSURLForEvents || '',

  webhookPath: process.env.WEBHOOK_PATH || '/webhook',

  clientId: process.env.ZOOM_CLIENT_ID,
  clientSecret: process.env.ZOOM_CLIENT_SECRET,

  s2sClientId: process.env.ZOOM_S2S_CLIENT_ID || null,
  s2sClientSecret: process.env.ZOOM_S2S_CLIENT_SECRET || null,
  accountId: process.env.ZOOM_ACCOUNT_ID || null,

  zoomSecretToken: process.env.ZOOM_SECRET_TOKEN,
  ws_url: process.env.WS_URL,
};

// Utility functions
function generateSignature(meetingUuid, streamId, clientId, clientSecret) {
  const message = `${clientId},${meetingUuid},${streamId}`;
  return crypto.createHmac('sha256', clientSecret).update(message).digest('hex');
}

// Logging functions
function logHandshakeResponse(errorCode) {
}

function logRtmsSessionState(stateCode) {
  switch (stateCode) {
    case 0:
      console.log('Session state: INACTIVE (default)');
      break;
    case 1:
      console.log('Session state: INITIALIZE (session is initializing)');
      break;
    case 2:
      console.log('Session state: STARTED (session has started)');
      break;
    case 3:
      console.log('Session state: PAUSED (session is paused)');
      break;
    case 4:
      console.log('Session state: RESUMED (session has resumed)');
      break;
    case 5:
      console.log('Session state: STOPPED (session has stopped)');
      break;
    default:
      console.log(`Session state: Unknown state (${stateCode})`);
  }
}

function logRtmsStreamState(stateCode) {
  switch (stateCode) {
    case 0:
      console.log('Stream state: INACTIVE (default state)');
      break;
    case 1:
      console.log('Stream state: ACTIVE (media is being transmitted)');
      break;
    case 2:
      console.log('Stream state: INTERRUPTED (connection issue detected)');
      break;
    case 3:
      console.log('Stream state: TERMINATING (client notified to terminate)');
      break;
    case 4:
      console.log('Stream state: TERMINATED (stream has ended)');
      break;
    default:
      console.log(`Stream state: Unknown state (${stateCode})`);
  }
}

function logRtmsStopReason(errorCode) {
  switch (errorCode) {
    case 0:
      console.log('RTMS stopped: UNDEFINED');
      break;
    case 1:
      console.log('RTMS stopped: Host triggered (STOP_BC_HOST_TRIGGERED)');
      break;
    case 2:
      console.log('RTMS stopped: User triggered (STOP_BC_USER_TRIGGERED)');
      break;
    case 3:
      console.log('RTMS stopped: App user left meeting (STOP_BC_USER_LEFT)');
      break;
    case 4:
      console.log('RTMS stopped: App user ejected by host (STOP_BC_USER_EJECTED)');
      break;
    case 5:
      console.log('RTMS stopped: App disabled by host (STOP_BC_APP_DISABLED_BY_HOST)');
      break;
    case 6:
      console.log('RTMS stopped: Meeting ended (STOP_BC_MEETING_ENDED)');
      break;
    case 7:
      console.log('RTMS stopped: Stream canceled by participant (STOP_BC_STREAM_CANCELED)');
      break;
    case 8:
      console.log('RTMS stopped: Stream revoked — delete assets immediately (STOP_BC_STREAM_REVOKED)');
      break;
    case 9:
      console.log('RTMS stopped: All apps disabled by host (STOP_BC_ALL_APPS_DISABLED)');
      break;
    case 10:
      console.log('RTMS stopped: Internal exception (STOP_BC_INTERNAL_EXCEPTION)');
      break;
    case 11:
      console.log('RTMS stopped: Connection timeout (STOP_BC_CONNECTION_TIMEOUT)');
      break;
    case 12:
      console.log('RTMS stopped: Meeting connection interrupted (STOP_BC_MEETING_CONNECTION_INTERRUPTED)');
      break;
    case 13:
      console.log('RTMS stopped: Signaling connection interrupted (STOP_BC_SIGNAL_CONNECTION_INTERRUPTED)');
      break;
    case 14:
      console.log('RTMS stopped: Data connection interrupted (STOP_BC_DATA_CONNECTION_INTERRUPTED)');
      break;
    case 15:
      console.log('RTMS stopped: Signaling connection closed abnormally (STOP_BC_SIGNAL_CONNECTION_CLOSED_ABNORMALLY)');
      break;
    case 16:
      console.log('RTMS stopped: Data connection closed abnormally (STOP_BC_DATA_CONNECTION_CLOSED_ABNORMALLY)');
      break;
    case 17:
      console.log('RTMS stopped: Received exit signal (STOP_BC_EXIT_SIGNAL)');
      break;
    case 18:
      console.log('RTMS stopped: Authentication failure (STOP_BC_AUTHENTICATION_FAILURE)');
      break;
    default:
      console.log(`RTMS stopped: Unknown reason code (${errorCode})`);
  }
}

function logRtmsStatusCode(statusCode) {
  switch (statusCode) {
    case 0:
      console.log('RTMS status: OK');
      break;
    case 1:
      console.log('RTMS status: CONNECTION_TIMEOUT');
      break;
    case 2:
      console.log('RTMS status: INVALID_JSON_MSG_SIZE');
      break;
    case 3:
      console.log('RTMS status: INVALID_JSON_MSG');
      break;
    case 4:
      console.log('RTMS status: INVALID_MESSAGE_TYPE');
      break;
    case 5:
      console.log('RTMS status: MSG_TYPE_NOT_EXIST');
      break;
    case 6:
      console.log('RTMS status: MSG_TYPE_NOT_UINT');
      break;
    case 7:
      console.log('RTMS status: MEETING_UUID_NOT_EXIST');
      break;
    case 8:
      console.log('RTMS status: MEETING_UUID_NOT_STRING');
      break;
    case 9:
      console.log('RTMS status: MEETING_UUID_IS_EMPTY');
      break;
    case 10:
      console.log('RTMS status: RTMS_STREAM_ID_NOT_EXIST');
      break;
    case 11:
      console.log('RTMS status: RTMS_STREAM_ID_NOT_STRING');
      break;
    case 12:
      console.log('RTMS status: RTMS_STREAM_ID_IS_EMPTY');
      break;
    case 13:
      console.log('RTMS status: SESSION_NOT_FOUND');
      break;
    case 14:
      console.log('RTMS status: SIGNATURE_NOT_EXIST');
      break;
    case 15:
      console.log('RTMS status: INVALID_SIGNATURE');
      break;
    case 16:
      console.log('RTMS status: INVALID_MEETING_OR_STREAM_ID');
      break;
    case 17:
      console.log('RTMS status: DUPLICATE_SIGNAL_REQUEST');
      break;
    case 18:
      console.log('RTMS status: EVENTS_NOT_EXIST');
      break;
    case 19:
      console.log('RTMS status: EVENTS_VALUE_NOT_ARRAY');
      break;
    case 20:
      console.log('RTMS status: EVENT_TYPE_NOT_EXIST');
      break;
    case 21:
      console.log('RTMS status: EVENT_TYPE_VALUE_NOT_UINT');
      break;
    case 22:
      console.log('RTMS status: MEDIA_TYPE_NOT_EXIST');
      break;
    case 23:
      console.log('RTMS status: MEDIA_TYPE_NOT_UINT');
      break;
    case 24:
      console.log('RTMS status: MEDIA_TYPE_AUDIO_NOT_SUPPORT');
      break;
    case 25:
      console.log('RTMS status: MEDIA_TYPE_VIDEO_NOT_SUPPORT');
      break;
    case 26:
      console.log('RTMS status: MEDIA_TYPE_DESKSHARE_NOT_SUPPORT');
      break;
    case 27:
      console.log('RTMS status: MEDIA_TYPE_TRANSCRIPT_NOT_SUPPORT');
      break;
    case 28:
      console.log('RTMS status: MEDIA_TYPE_CHAT_NOT_SUPPORT');
      break;
    case 29:
      console.log('RTMS status: MEDIA_TYPE_INVALID_VALUE');
      break;
    case 30:
      console.log('RTMS status: MEDIA_DATA_ALL_CONNECTION_EXIST');
      break;
    case 31:
      console.log('RTMS status: DUPLICATE_MEDIA_DATA_CONNECTION');
      break;
    case 32:
      console.log('RTMS status: MEDIA_PARAMS_NOT_EXIST');
      break;
    case 33:
      console.log('RTMS status: INVALID_MEDIA_PARAMS');
      break;
    case 34:
      console.log('RTMS status: NO_MEDIA_TYPE_SPECIFIED');
      break;
    case 35:
      console.log('RTMS status: INVALID_MEDIA_AUDIO_PARAMS');
      break;
    case 36:
      console.log('RTMS status: MEDIA_AUDIO_CONTENT_TYPE_NOT_UINT');
      break;
    case 37:
      console.log('RTMS status: INVALID_MEDIA_AUDIO_CONTENT_TYPE');
      break;
    case 38:
      console.log('RTMS status: MEDIA_AUDIO_SAMPLE_RATE_NOT_UINT');
      break;
    case 39:
      console.log('RTMS status: INVALID_MEDIA_AUDIO_SAMPLE_RATE');
      break;
    case 40:
      console.log('RTMS status: MEDIA_AUDIO_CHANNEL_NOT_UINT');
      break;
    case 41:
      console.log('RTMS status: INVALID_MEDIA_AUDIO_CHANNEL');
      break;
    case 42:
      console.log('RTMS status: MEDIA_AUDIO_CODEC_NOT_UINT');
      break;
    case 43:
      console.log('RTMS status: INVALID_MEDIA_AUDIO_CODEC');
      break;
    case 44:
      console.log('RTMS status: MEDIA_AUDIO_DATA_OPT_NOT_UINT');
      break;
    case 45:
      console.log('RTMS status: INVALID_MEDIA_AUDIO_DATA_OPT');
      break;
    case 46:
      console.log('RTMS status: MEDIA_AUDIO_SEND_RATE_NOT_UINT');
      break;
    case 47:
      console.log('RTMS status: MEDIA_AUDIO_FRAME_SIZE_NOT_UINT');
      break;
    case 48:
      console.log('RTMS status: INVALID_MEDIA_VIDEO_PARAMS');
      break;
    case 49:
      console.log('RTMS status: INVALID_MEDIA_VIDEO_CONTENT_TYPE');
      break;
    case 50:
      console.log('RTMS status: MEDIA_VIDEO_CONTENT_TYPE_NOT_UINT');
      break;
    case 51:
      console.log('RTMS status: INVALID_MEDIA_VIDEO_CODEC');
      break;
    case 52:
      console.log('RTMS status: MEDIA_VIDEO_CODEC_NOT_UINT');
      break;
    case 53:
      console.log('RTMS status: INVALID_MEDIA_VIDEO_RESOLUTION');
      break;
    case 54:
      console.log('RTMS status: MEDIA_VIDEO_RESOLUTION_NOT_UINT');
      break;
    case 55:
      console.log('RTMS status: INVALID_MEDIA_VIDEO_DATA_OPT');
      break;
    case 56:
      console.log('RTMS status: MEDIA_VIDEO_DATA_OPT_NOT_UINT');
      break;
    case 57:
      console.log('RTMS status: MEDIA_VIDEO_FPS_NOT_UINT');
      break;
    case 58:
      console.log('RTMS status: INVALID_MEDIA_SHARE_PARAMS');
      break;
    case 59:
      console.log('RTMS status: INVALID_AUDIO_DATA_BUFFER');
      break;
    case 60:
      console.log('RTMS status: INVALID_VIDEO_DATA_BUFFER');
      break;
    case 61:
      console.log('RTMS status: POST_FIRST_PACKET_FAILURE');
      break;
    case 62:
      console.log('RTMS status: RTMS_SESSION_NOT_FOUND');
      break;
    default:
      console.log(`RTMS status: Unknown status code (${statusCode})`);
  }
}

// Media message handler
function handleMediaMessage(data, {
  conn,
  mediaWs,
  signalingSocket,
  meetingUuid,
  streamId
}) {
  try {
    const msg = JSON.parse(data.toString());

    switch (msg.msg_type) {

      case 4: // DATA_HAND_SHAKE_RESP
        if (msg.status_code === 0) {
          signalingSocket.send(JSON.stringify({
            msg_type: 7,
            rtms_stream_id: streamId
          }));
          conn.media.state = 'streaming';
        }
        else {
          logRtmsStatusCode(msg.status_code);
          if (msg.reason) {
            logRtmsStopReason(msg.reason);
          }
        }
        break;

      case 12: // KEEP_ALIVE_REQ
        console.log("case 12");
        conn.media.lastKeepAlive = Date.now();
        console.log('Responding to KEEP_ALIVE_REQ');
        mediaWs.send(JSON.stringify({
          msg_type: 13,
          timestamp: msg.timestamp
        }));
        break;

      case 14: // AUDIO
        if (msg.content?.data) {
          const { user_id, user_name, data: audioData } = msg.content;
          const buffer = Buffer.from(audioData, 'base64');
           //console.log('Audio data received from '+user_id +":"+ user_name);
        }
        break;

      case 15: // VIDEO
        if (msg.content?.data) {
          const { user_id, user_name, data: videoData, timestamp } = msg.content;
          const buffer = Buffer.from(videoData, 'base64');
           console.log('Video data received from '+user_id+":"+user_name);
        }
        break;

      case 16: // SHARESCREEN
        if (msg.content?.data) {
          const { user_id, user_name, data: shareData, timestamp } = msg.content;
          const buffer = Buffer.from(shareData, 'base64');
          console.log('Sharescreen data received');
        }
        break;

      case 17:   // TRANSCRIPT
        if (msg.content?.data) {
          console.log('Transcript data received');
        }
        break;

      case 18: // CHAT
        if (msg.content?.data) {
          console.log('Chat data received');
        }
        break;

      default:
        break;
    }
  } catch (err) {
    console.error('Failed to parse message:', data.toString('hex'));
  }
}

// Connect to media WebSocket
function connectToMediaWebSocket(
  mediaUrl,
  meetingUuid,
  streamId,
  signalingSocket,
  conn,
  clientId,
  clientSecret,
  activeConnections
) {
  console.log(`[Media] Connecting for meeting ${meetingUuid}...`);
  const mediaWs = new WebSocket(mediaUrl);
  conn.media.socket = mediaWs;
  conn.media.state = 'connecting';

  mediaWs.on('open', () => {
    if (!conn.shouldReconnect) {
      console.warn(`[Media] Aborting open: RTMS stopped for ${meetingUuid}`);
      mediaWs.close();
      return;
    }

    const signature = generateSignature(meetingUuid, streamId, clientId, clientSecret);

    const handshakeMsg = {
      msg_type: 3, // DATA_HAND_SHAKE_REQ
      protocol_version: 1,
      meeting_uuid: meetingUuid,
      rtms_stream_id: streamId,
      signature,
      media_type: 32, // AUDIO+VIDEO+TRANSCRIPT
      payload_encryption: false,
      media_params: {
        audio: {
          content_type: 1, //RTP
          sample_rate: 1, //16k
          channel: 1, //mono
          codec: 1, //L16
          data_opt: 1, //AUDIO_MIXED_STREAM
          send_rate: 100 //in Milliseconds
        },
        video: {
          codec: 7, //H264
          data_opt: 3, //VIDEO_SINGLE_ACTIVE_STREAM
          resolution: 2, //720p
          fps: 25
        },
        deskshare: {
          codec: 5, //JPG,
          resolution: 2, //720p
          fps: 1
        },
        chat: {
          content_type: 5, //TEXT
        },
        transcript: {
          content_type: 5 //TEXT
        }
      }
    };

    mediaWs.send(JSON.stringify(handshakeMsg));
    conn.media.state = 'authenticated';
  });

  mediaWs.on('message', (data) => {
    handleMediaMessage(data, {
      conn,
      mediaWs,
      signalingSocket,
      meetingUuid,
      streamId
    });
  });

  mediaWs.on('close', async () => {
    console.warn(`[Media] Closed for ${meetingUuid}`);
    conn.media.state = 'closed';

    if (!conn.shouldReconnect) {
      console.log(`[Media] Not reconnecting — RTMS was stopped.`);
      return;
    }

    if (
      conn.signaling.state === 'ready' &&
      conn.signaling.socket?.readyState === WebSocket.OPEN
    ) {
      console.log(`[Media] Reconnecting in 3s...`);
      setTimeout(() => {
        connectToMediaWebSocket(
          mediaUrl,
          meetingUuid,
          streamId,
          conn.signaling.socket,
          conn,
          clientId,
          clientSecret,
          activeConnections
        );
      }, 3000);
    } else {
      console.warn(`[Media] Signaling not ready. Restarting both sockets...`);
      connectToSignalingWebSocket(
        meetingUuid,
        streamId,
        conn.serverUrls,
        activeConnections,
        clientId,
        clientSecret
      );
    }
  });

  mediaWs.on('error', (err) => {
    console.error(`[Media] Error: ${err.message}`);
    conn.media.state = 'error';
  });
}

// Connect to signaling WebSocket
function connectToSignalingWebSocket(
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
        if (msg.reason === 6 && msg.state === 4) {
          console.log(`[Signaling] Meeting ended detected, cleaning up connections for ${meetingUuid}`);

          if (conn) {
            conn.shouldReconnect = false;
            console.log(`[Signaling] Disabled reconnection for ${meetingUuid}`);

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
              conn.serverUrls,
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




// Main application
const app = express();
const port = config.port;

app.use(express.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(express.static(path.join(__dirname, 'public')));

const activeConnections = new Map();

app.set('view engine', 'ejs');

app.get('/', (req, res) => {
  res.render('index', {
    websocketUrl: config.ws_url || 'wss://yoururl.ngrok.com/ws'
  });
});

if (config.mode === "webhook") {
  console.log("wehook mode");
  app.post(config.webhookPath, async (req, res) => {
    res.sendStatus(200);
    const { event, payload } = req.body;
    console.log('Webhook received:', event);

    if (event === 'endpoint.url_validation' && payload?.plainToken) {
      const hash = crypto.createHmac('sha256', config.zoomSecretToken)
        .update(payload.plainToken)
        .digest('hex');
      return res.json({
        plainToken: payload.plainToken,
        encryptedToken: hash,
      });
    }

    else if (event === 'meeting.rtms_started') {
      const { meeting_uuid, rtms_stream_id, server_urls } = payload;
      console.log(`Starting RTMS for meeting ${meeting_uuid}`);

      activeConnections.set(meeting_uuid, {
        meetingUuid: meeting_uuid,
        streamId: rtms_stream_id,
        serverUrls: server_urls,
        shouldReconnect: true,
        signaling: { socket: null, state: 'connecting', lastKeepAlive: null },
        media: { socket: null, state: 'idle', lastKeepAlive: null },
      });

      connectToSignalingWebSocket(
        meeting_uuid,
        rtms_stream_id,
        server_urls,
        activeConnections,
        config.clientId,
        config.clientSecret
      );
    }

    else if (event === 'meeting.rtms_stopped') {
      const { meeting_uuid } = payload;
      console.log(`Stopping RTMS for meeting ${meeting_uuid}`);

      const conn = activeConnections.get(meeting_uuid);
      if (conn) {
        conn.shouldReconnect = false;

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

        activeConnections.delete(meeting_uuid);
      }
    }


  });
}

else if (config.mode === 'websocket') {
  console.log("websocket mode");
  const baseWsUrl = config.zoomWSURLForEvents;
  const clientId = config.clientId;
  const clientSecret = config.clientSecret;

  if (!baseWsUrl || !clientId || !clientSecret) {
    console.error('❌ Missing required env vars: ZOOM_EVENT_WS_BASE, ZOOM_CLIENT_ID, or ZOOM_CLIENT_SECRET');

  }

  const accessToken = await new Promise((resolve, reject) => {
    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const options = {
      method: 'POST',
      hostname: 'zoom.us',
      path: '/oauth/token?grant_type=client_credentials',
      headers: {
        'Authorization': `Basic ${credentials}`
      }
    };

    const req = https.request(options, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          const tokenData = JSON.parse(body);
          console.log('✅ Zoom access token received.');
          resolve(tokenData.access_token);
        } else {
          console.error(`❌ Zoom token request failed: ${res.statusCode} ${body}`);
          resolve(null);
        }
      });
    });

    req.on('error', (err) => {
      console.error('❌ HTTPS error requesting token:', err.message);
      resolve(null);
    });

    req.end();
  });

  if (!accessToken) {
    console.error('No access token returned');
  }

  const fullWsUrl = `${baseWsUrl}&access_token=${accessToken}`;
  console.log(`🔗 Full WebSocket URL: ${fullWsUrl}`);

  const ws = new WebSocket(fullWsUrl);

  ws.on('open', () => {
    
    console.log('✅ WebSocket connection established.');
    ws.send(JSON.stringify({ module: 'heartbeat' }));
    console.log('💓 Sent initial heartbeat');

    const interval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ module: 'heartbeat' }));
        console.log('💓 Heartbeat sent');
      } else {
        clearInterval(interval);
      }
    }, 30000);
  });

  ws.on('message', async (message) => {
    console.log('📥 Received message from Zoom Event WebSocket');
    console.debug(`🔍 Raw Message:\n${message}`);

    try {
      const msg = JSON.parse(message);
      if (msg.module === 'message' && msg.content) {
        const eventData = JSON.parse(msg.content);
        const event = eventData.event;
        const payload = eventData.payload || {};

        console.log(`🧠 Parsed Event: ${event}`);
        console.debug(`📦 Payload:`, payload);

        if (event === 'meeting.rtms_started') {
          const { meeting_uuid, rtms_stream_id, server_urls } = payload;
          console.log(`🚀 Triggering signaling WebSocket for ${meeting_uuid}`);

          activeConnections.set(meeting_uuid, {
            meetingUuid: meeting_uuid,
            streamId: rtms_stream_id,
            serverUrls: server_urls,
            shouldReconnect: true,
            signaling: { socket: null, state: 'connecting', lastKeepAlive: null },
            media: { socket: null, state: 'idle', lastKeepAlive: null },
          });

          connectToSignalingWebSocket(
            meeting_uuid,
            rtms_stream_id,
            server_urls,
            activeConnections,
            clientId,
            clientSecret
          );
        }

        if (event === 'meeting.rtms_stopped') {
          const { meeting_uuid } = payload;
          console.log(`🛑 Closing signaling for ${meeting_uuid}`);

          const conn = activeConnections.get(meeting_uuid);
          if (conn) {
            for (const key in conn) {
              try {
                conn[key]?.close?.();
              } catch (err) {
                console.warn(`⚠️ Error closing ${key}:`, err.message);
              }
            }
            activeConnections.delete(meeting_uuid);
          }
        }
      }
    } catch (err) {
      console.error('❌ Error processing message:', err.message);
    }
  });

  ws.on('error', (err) => {
    console.error(`⚠️ WebSocket Error: ${err.message}`);
  });

  ws.on('close', (code, reason) => {
    console.warn(`🔌 WebSocket closed | Code: ${code}, Reason: ${reason}`);
  });

}

const server = http.createServer(app);


server.listen(port, () => {
  console.log(`🚀 Server running at http://localhost:${port}`);
  console.log(`📩 Webhook available at http://localhost:${port}${config.webhookPath}`);
  console.log(`🌐 Frontend WebSocket available at ws://localhost:${port}/ws`);
});
