import WebSocket from 'ws';
import { generateSignature } from './utils/signature.js';
import { handleMediaMessage } from './mediaMessageHandler.js';

export function connectToMediaWebSocket(
  mediaUrl,
  meetingUuid,
  streamId,
  signalingSocket,
  conn,
  clientId,
  clientSecret,
  activeConnections,
  sharedServices = null
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
      media_type: 8, // TRANSCRIPT
      payload_encryption: false,
      media_params: {
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
      streamId,
      sharedServices
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
          activeConnections,
          sharedServices
        );
      }, 3000);
    } else {
      console.warn(`[Media] Signaling not ready. Restarting both sockets...`);
      const { connectToSignalingWebSocket } = await import('./signalingSocket.js');
      connectToSignalingWebSocket(
        meetingUuid,
        streamId,
        conn.serverUrls,
        activeConnections,
        clientId,
        clientSecret,
        null, // broadcastToFrontendClients
        sharedServices
      );
    }
  });

  mediaWs.on('error', (err) => {
    console.error(`[Media] Error: ${err.message}`);
    conn.media.state = 'error';
  });
}
