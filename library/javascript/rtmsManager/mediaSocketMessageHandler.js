import {
  getHandshakeResponse,
  getRtmsSessionState,
  getRtmsStreamState,
  getRtmsStopReason,
  getRtmsStatusCode
} from './utils/rtmsEventLookupHelper.js';

import { processAudio } from './processors/audioProcessor.js';
import { processVideo } from './processors/videoProcessor.js';
import { processSharescreen } from './processors/sharescreenProcessor.js';
import { processTranscript } from './processors/transcriptProcessor.js';
import { processChat } from './processors/chatProcessor.js';
import { FileLogger } from './utils/FileLogger.js';


export async function handleMediaMessage(data, {
  conn,
  mediaWs,
  signalingSocket,
  meetingUuid,
  streamId,
  mediaType,
  emit
}) {
  try {
    const msg = JSON.parse(data.toString());

    switch (msg.msg_type) {

      // {
      //   "msg_type": 4,
      //   "protocol_version": 1,
      //   "status_code": 0,
      //   "reason": "",
      //   "sequence": 0,
      //   "payload_encrypted": true,
      //   "media_params": {
      //     "audio": {
      //       "content_type": 2,
      //       "sample_rate": 1,
      //       "channel": 1,
      //       "codec": 1,
      //       "data_opt": 1,
      //       "send_rate": 100
      //     },
      //     "video": {
      //       "content_type": 3,
      //       "codec": 5,
      //       "resolution": 2,
      //       "data_opt": 3,
      //       "fps": 5
      //     }
      //   }
      // }

      case 4: // DATA_HAND_SHAKE_RESP
        FileLogger.log(`[Media] [${conn.rtmsType},${meetingUuid},${streamId}] Handshake response: ${JSON.stringify(msg)}`);

        //no error
        if (msg.status_code === 0) {

          // {
          //   "msg_type": 7,
          //   "rtms_stream_id": "03db704592624398931a588dd78200cb"
          // }

          signalingSocket.send(JSON.stringify({
            msg_type: 7,
            rtms_stream_id: streamId
          }));

          // Set state correctly based on connection mode
          if (mediaType && conn.media[mediaType]) {
            // Split mode - set state on specific media type socket
            conn.media[mediaType].state = 'streaming';
          } else if (conn.media && typeof conn.media.state !== 'undefined') {
            // Unified mode - set state on media object
            conn.media.state = 'streaming';
          }
        }
        else {

          FileLogger.log(`[Media] [${conn.rtmsType},${meetingUuid},${streamId}] ${getRtmsStatusCode(msg.status_code)}`);
          if (msg.reason) {
            FileLogger.log(`[Media] [${conn.rtmsType},${meetingUuid},${streamId}] ${getRtmsStopReason(msg.reason)}`);
          }
        }
        break;

      case 12: // KEEP_ALIVE_REQ
        // Update keep-alive timestamp based on connection mode
        if (mediaType && conn.media[mediaType]) {
          // Split mode - track keep-alive per media type
          conn.media[mediaType].lastKeepAlive = Date.now();
        } else if (conn.media) {
          // Unified mode - track on media object
          conn.media.lastKeepAlive = Date.now();
        }
        FileLogger.log(`[Media] [${conn.rtmsType},${meetingUuid},${streamId}]     Case 12, Responding to KEEP_ALIVE_REQ`);
        
        mediaWs.send(JSON.stringify({
          msg_type: 13,
          timestamp: msg.timestamp
        }));
        break;

      // {
      //   "msg_type": 14, 
      //   "content": {
      //     "user_id": 16778240, // 0 if mixed audio
      //     "user_name": "John Smith", // empty if user_id is 0
      //     "data": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxx==",
      //     "timestamp": 1738392033699
      //   }

      case 14: // AUDIO
        if (msg.content?.data) {
          const { user_id, user_name, data: audioData, timestamp } = msg.content;
          const buffer = Buffer.from(audioData, 'base64');
          // For mixed audio streams, Zoom sends user_id=0 and empty user_name
          const displayName = user_name || (user_id === 0 ? 'Mixed Audio' : `User ${user_id}`);
          await processAudio(buffer, user_id, displayName, timestamp, meetingUuid, streamId, emit, conn.rtmsType, conn.audioFiller);
        }
        break;

      case 15: // VIDEO
        if (msg.content?.data) {
          const { user_id, user_name, data: videoData, timestamp } = msg.content;
          const buffer = Buffer.from(videoData, 'base64');
          await processVideo(buffer, user_id, user_name, timestamp, meetingUuid, streamId, emit, conn.rtmsType, conn.videoFiller);
        }
        break;

      case 16: // SHARESCREEN
        if (msg.content?.data) {
          const { user_id, user_name, data: shareData, timestamp } = msg.content;
          const buffer = Buffer.from(shareData, 'base64');
          await processSharescreen(buffer, user_id, user_name, timestamp, meetingUuid, streamId, emit, conn.rtmsType);
        }
        break;

      case 17: // TRANSCRIPT
        if (msg.content?.data) {
          const { user_id, user_name, data: transcriptData, timestamp, start_time, end_time, language, attribute } = msg.content;
          await processTranscript(transcriptData, user_id, user_name, timestamp, meetingUuid, streamId, emit, conn.rtmsType, start_time, end_time, language, attribute);
        }
        break;

      case 18: // CHAT
        if (msg.content?.data) {
          const { user_id, user_name, data: chatData, timestamp } = msg.content;
          await processChat(chatData, user_id, user_name, timestamp, meetingUuid, streamId, emit, conn.rtmsType);
        }
        break;

      default:
        // Unknown message type
        break;
    }
  } catch (err) {
    FileLogger.error(`Failed to parse message: ${data.toString('hex')}`);
  }
}
