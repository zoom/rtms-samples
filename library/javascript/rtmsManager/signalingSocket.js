import WebSocket from 'ws';
import { generateRTMSSignature } from './utils/signatureHelper.js';
import { connectToMediaWebSocket } from './mediaSocket.js';
import { handleSignalingMessage } from './signalingSocketMessageHandler.js';
import {
  getRtmsSessionState,
  getRtmsStreamState,
  getRtmsStopReason,
  getRtmsStatusCode
} from './utils/rtmsEventLookupHelper.js';
import { FileLogger } from './utils/FileLogger.js';

export function connectToSignalingWebSocket(
  meetingUuid,
  streamId,
  serverUrls,
  conn,
  clientId,
  clientSecret,
  mediaSocketConnectionMode,
  emit,
  mediaTypesFlag = 32
) {
  FileLogger.log(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] Starting connection function for ${conn.rtmsType} ${meetingUuid}`);
  FileLogger.log(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] Stream ID: ${streamId}, Server URL: ${serverUrls}`);
  FileLogger.log(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] Connecting for ${conn.rtmsType} ${meetingUuid}`);


  if (!serverUrls || typeof serverUrls !== 'string' || !serverUrls.startsWith('ws')) {
    FileLogger.error(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] ❌ Invalid WebSocket URL: ${serverUrls}`);
    FileLogger.error(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] URL validation failed - URL is null/undefined or doesn't start with ws/wss`);

    conn.shouldReconnect = false;
    return;
  }

  let signalingWs;
  try {
    FileLogger.log(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] Creating WebSocket instance for ${serverUrls}`);
    signalingWs = new WebSocket(serverUrls);
    FileLogger.log(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] WebSocket instance created successfully`);
  } catch (err) {
    FileLogger.error(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] ❌ Failed to create WebSocket instance: ${err.message}`);
    return;
  }

  conn.meetingUuid = meetingUuid;
  conn.streamId = streamId;
  conn.serverUrls = serverUrls;
  if (!conn.mediaSocketConnectionMode) conn.mediaSocketConnectionMode = mediaSocketConnectionMode;
  if (!conn.mediaTypesFlag) conn.mediaTypesFlag = mediaTypesFlag;
  conn.mediaSocketConnectionMode = mediaSocketConnectionMode;
  // conn.mediaTypesFlag = mediaTypesFlag;
  conn.signaling.socket = signalingWs;
  conn.signaling.state = 'connecting';
  FileLogger.log(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] Connection state set to 'connecting' for ${conn.rtmsType} ${meetingUuid}`);

  signalingWs.on('open', () => {
    try {
      FileLogger.log(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] WebSocket opened successfully for ${conn.rtmsType} ${meetingUuid}`);
      if (!conn.shouldReconnect) {
        FileLogger.warn(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] Aborting open: RTMS stopped for ${conn.rtmsType} ${meetingUuid}`);
        signalingWs.close();
        return;
      }

      FileLogger.log(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] Generating signature for handshake`);
     
      const messageToSign = `${clientId},${meetingUuid},${streamId}`;
       FileLogger.log(`[Signaling] Message to sign: [REDACTED],${meetingUuid},${streamId}`);
      const signature = generateRTMSSignature(meetingUuid, streamId, clientId, clientSecret);

      const handshakeMsg = {
        msg_type: 1,
        meeting_uuid: meetingUuid,
        rtms_stream_id: streamId,
        signature,
      };

      FileLogger.log(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] Sending handshake for ${conn.rtmsType} ${meetingUuid}`);
      FileLogger.log(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] Handshake payload: ${JSON.stringify({ ...handshakeMsg, signature: '[REDACTED]' }, null, 2)}`);
      signalingWs.send(JSON.stringify(handshakeMsg));
      conn.signaling.state = 'authenticated';
      FileLogger.log(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] Connection state updated to 'authenticated' for ${conn.rtmsType} ${meetingUuid}`);
    } catch (err) {
      FileLogger.error(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] Error in WebSocket open handler for ${conn.rtmsType} ${meetingUuid}: ${err.message}`);

      conn.signaling.state = 'error';
      signalingWs.close();
    }
  });

  signalingWs.on('message', (data) => {
    handleSignalingMessage(data, meetingUuid, streamId, signalingWs, conn, emit, mediaSocketConnectionMode, mediaTypesFlag, clientId, clientSecret);
  });

  signalingWs.on('close', (code, reason) => {
    FileLogger.log(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] WebSocket closed for ${conn.rtmsType} ${meetingUuid}, code: ${code}, reason: ${reason}`);

    conn.signaling.state = 'closed';
    FileLogger.log(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] Connection state updated to 'closed' for ${conn.rtmsType} ${meetingUuid}`);

    if (conn.shouldReconnect) {
      FileLogger.log(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] Will reconnect for ${conn.rtmsType} ${meetingUuid} in 3s...`);
      setTimeout(() => {
        if (conn.shouldReconnect) {
          FileLogger.log(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] Starting reconnection for ${conn.rtmsType} ${meetingUuid}`);
          connectToSignalingWebSocket(
            meetingUuid,
            streamId,
            conn.serverUrls,
            conn,
            clientId,
            clientSecret,
            conn.mediaSocketConnectionMode,
            emit,
            conn.mediaTypesFlag
          );
        } else {
          FileLogger.log(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] Reconnection cancelled for ${conn.rtmsType} ${meetingUuid}`);
        }
      }, 3000);
    } else {
      FileLogger.log(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] Not reconnecting — RTMS was stopped for ${conn.rtmsType} ${meetingUuid}.`);
    }
  });

  signalingWs.on('error', (err) => {
    FileLogger.error(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] WebSocket error for ${conn.rtmsType} ${meetingUuid}: ${err.message}`);

    conn.signaling.state = 'error';
    FileLogger.log(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] Connection state updated to 'error' for ${conn.rtmsType} ${meetingUuid}`);
  });
}
