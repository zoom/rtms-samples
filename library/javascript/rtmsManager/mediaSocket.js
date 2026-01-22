import WebSocket from 'ws';
import { generateRTMSSignature } from './utils/signatureHelper.js';
import { handleMediaMessage } from './mediaSocketMessageHandler.js';
import { FileLogger } from './utils/FileLogger.js';

const TYPE_FLAGS = {
  audio: 1,
  video: 2,
  sharescreen: 4,
  transcript: 8,
  chat: 16
};

/**
 * Connect to a media WebSocket for a specific media type.
 * 
 * SPLIT MODE ONLY: Each media type (audio, video, etc.) gets its own dedicated
 * WebSocket connection. This is the recommended approach for reliability and
 * allows independent reconnection per media type.
 * 
 * @param {string} mediaUrl - WebSocket URL for the media server
 * @param {string} meetingUuid - Meeting UUID
 * @param {string} streamId - RTMS stream ID
 * @param {WebSocket} signalingSocket - The signaling socket (for reference)
 * @param {Object} conn - Connection object
 * @param {string} clientId - Zoom client ID
 * @param {string} clientSecret - Zoom client secret
 * @param {string} mediaType - Media type: 'audio', 'video', 'sharescreen', 'transcript', 'chat'
 * @param {number} mediaTypeFlag - Bitmask flag for this media type
 * @param {Function} emit - Event emitter function
 */
export function connectToMediaWebSocket(
  mediaUrl,
  meetingUuid,
  streamId,
  signalingSocket,
  conn,
  clientId,
  clientSecret,
  mediaType,
  mediaTypeFlag,
  emit
) {
  FileLogger.log(`[Media] [${conn.rtmsType},${meetingUuid},${streamId}] Connecting ${mediaType} socket to ${mediaUrl}...`);

  const mediaWs = new WebSocket(mediaUrl);

  // Each media type gets its own connection object
  const mediaObj = conn.media[mediaType] || { socket: null, state: 'idle', url: mediaUrl };
  if (!conn.media[mediaType]) conn.media[mediaType] = mediaObj;

  mediaObj.socket = mediaWs;
  mediaObj.state = 'connecting';
  mediaObj.url = mediaUrl;
  mediaObj.mediaTypeFlag = mediaTypeFlag;

  mediaWs.on('open', () => {
    if (!conn.shouldReconnect) {
      FileLogger.warn(`[Media] [${conn.rtmsType},${meetingUuid},${streamId}] Aborting open: RTMS stopped for ${conn.rtmsType} ${meetingUuid}`);
      mediaWs.close();
      return;
    }

    FileLogger.log(`[Media] [${conn.rtmsType},${meetingUuid},${streamId}] Generating signature for ${mediaType} handshake`);
    

      const messageToSign = `${clientId},${meetingUuid},${streamId}`;
       FileLogger.log(`[Media] [${conn.rtmsType},${meetingUuid},${streamId}] Message to sign: ${messageToSign}`);
    const signature = generateRTMSSignature(meetingUuid, streamId, clientId, clientSecret);
   

    const mediaParams = conn.config?.mediaParams || {
      audio: {
        content_type: 1,
        sample_rate: 1,
        channel: 1,
        codec: 1,
        data_opt: 1,
        send_rate: 100
      },
      video: {
        codec: 7,
        data_opt: 3,
        resolution: 2,
        fps: 25
      },
      deskshare: {
        codec: 5,
        resolution: 2,
        fps: 1
      },
      chat: {
        content_type: 5
      },
      transcript: {
        content_type: 5
      }
    };

    const handshakeMsg = {
      msg_type: 3, // DATA_HAND_SHAKE_REQ
      protocol_version: 1,
      meeting_uuid: meetingUuid,
      rtms_stream_id: streamId,
      signature,
      media_type: mediaTypeFlag,
      payload_encryption: false,
      media_params: mediaParams
    };
    FileLogger.log(`[Media] [${conn.rtmsType},${meetingUuid},${streamId}] ${mediaType} handshake payload: ${JSON.stringify(handshakeMsg, null, 2)}`);

    // Store the media configuration in the connection object
    conn.mediaConfig = handshakeMsg.media_params;

    mediaWs.send(JSON.stringify(handshakeMsg));
    mediaObj.state = 'authenticated';
  });

  mediaWs.on('message', (data) => {
    handleMediaMessage(data, {
      conn,
      mediaWs,
      signalingSocket,
      meetingUuid,
      streamId,
      mediaType,
      emit
    });
  });

  mediaWs.on('close', async () => {
    FileLogger.warn(`[Media] [${conn.rtmsType},${meetingUuid},${streamId}] ${mediaType} socket closed`);
    mediaObj.state = 'closed';

    if (!conn.shouldReconnect) {
      FileLogger.log(`[Media] [${conn.rtmsType},${meetingUuid},${streamId}] Not reconnecting — RTMS was stopped.`);
      return;
    }

    if (
      conn.signaling.state === 'ready' &&
      conn.signaling.socket?.readyState === WebSocket.OPEN
    ) {
      FileLogger.log(`[Media] [${conn.rtmsType},${meetingUuid},${streamId}] Reconnecting in 3s...`);
      setTimeout(() => {
        connectToMediaWebSocket(
          mediaObj.url,
          meetingUuid,
          streamId,
          conn.signaling.socket,
          conn,
          clientId,
          clientSecret,
          mediaType,
          mediaObj.mediaTypeFlag,
          emit
        );
      }, 3000);
    } else {
      FileLogger.warn(`[Media] [${conn.rtmsType},${meetingUuid},${streamId}] Signaling not ready. Restarting both sockets...`);
      conn.connect();
    }
  });

  mediaWs.on('error', (err) => {
    FileLogger.error(`[Media] [${conn.rtmsType},${meetingUuid},${streamId}] ${mediaType} socket error: ${err.message}`);
    mediaObj.state = 'error';
  });
}
