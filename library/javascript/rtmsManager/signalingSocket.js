import WebSocket from 'ws';
import { generateRTMSSignature } from './utils/signatureHelper.js';
import { handleSignalingMessage } from './signalingSocketMessageHandler.js';
import { FileLogger } from './utils/FileLogger.js';
import { RTMSError } from './utils/RTMSError.js';

/**
 * Connect to the RTMS signaling WebSocket
 * Uses split mode only - each media type gets its own connection
 */
export function connectToSignalingWebSocket(
  meetingUuid,
  streamId,
  serverUrls,
  conn,
  clientId,
  clientSecret,
  emit,
  mediaTypesFlag = 32
) {
  FileLogger.log(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] Connecting...`);

  if (!serverUrls || typeof serverUrls !== 'string' || !serverUrls.startsWith('ws')) {
    const error = RTMSError.fromCode('CONNECTION_FAILED', {
      meetingId: meetingUuid,
      streamId
    });
    FileLogger.error(`[Signaling] ${error.toShortString()}`);
    emit('error', error);
    conn.shouldReconnect = false;
    return;
  }

  let signalingWs;
  try {
    signalingWs = new WebSocket(serverUrls);
  } catch (err) {
    const error = new RTMSError('CONNECTION_FAILED', `Failed to create WebSocket: ${err.message}`, {
      meetingId: meetingUuid,
      streamId,
      cause: err
    });
    FileLogger.error(`[Signaling] ${error.toShortString()}`);
    emit('error', error);
    return;
  }

  conn.meetingUuid = meetingUuid;
  conn.streamId = streamId;
  conn.serverUrls = serverUrls;
  if (!conn.mediaTypesFlag) conn.mediaTypesFlag = mediaTypesFlag;
  conn.signaling.socket = signalingWs;
  conn.signaling.state = 'connecting';

  signalingWs.on('open', () => {
    try {
      FileLogger.log(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] Connected, sending handshake`);
      
      if (!conn.shouldReconnect) {
        FileLogger.warn(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] Aborting - RTMS stopped`);
        signalingWs.close();
        return;
      }

      const signature = generateRTMSSignature(meetingUuid, streamId, clientId, clientSecret);

      const handshakeMsg = {
        msg_type: 1,
        protocol_version: 1,
        meeting_uuid: meetingUuid,
        rtms_stream_id: streamId,
        sequence: Math.floor(Math.random() * 1e9),
        signature,
      };

      signalingWs.send(JSON.stringify(handshakeMsg));
      conn.signaling.state = 'authenticated';
    } catch (err) {
      const error = new RTMSError('SIGNALING_ERROR', `Handshake failed: ${err.message}`, {
        meetingId: meetingUuid,
        streamId,
        cause: err
      });
      FileLogger.error(`[Signaling] ${error.toShortString()}`);
      emit('error', error);
      conn.signaling.state = 'error';
      signalingWs.close();
    }
  });

  signalingWs.on('message', (data) => {
    handleSignalingMessage(data, meetingUuid, streamId, signalingWs, conn, emit, mediaTypesFlag, clientId, clientSecret);
  });

  signalingWs.on('close', (code, reason) => {
    FileLogger.log(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] Closed (code: ${code})`);
    conn.signaling.state = 'closed';

    if (conn.shouldReconnect) {
      FileLogger.log(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] Reconnecting in 3s...`);
      setTimeout(() => {
        if (conn.shouldReconnect) {
          connectToSignalingWebSocket(
            meetingUuid,
            streamId,
            conn.serverUrls,
            conn,
            clientId,
            clientSecret,
            emit,
            conn.mediaTypesFlag
          );
        }
      }, 3000);
    }
  });

  signalingWs.on('error', (err) => {
    const error = new RTMSError('SIGNALING_ERROR', `WebSocket error: ${err.message}`, {
      meetingId: meetingUuid,
      streamId,
      cause: err
    });
    FileLogger.error(`[Signaling] ${error.toShortString()}`);
    emit('error', error);
    conn.signaling.state = 'error';
  });
}
