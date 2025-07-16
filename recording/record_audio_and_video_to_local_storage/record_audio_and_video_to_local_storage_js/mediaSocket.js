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
      const { connectToSignalingWebSocket } = await import('./signalingSocket.js');
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
