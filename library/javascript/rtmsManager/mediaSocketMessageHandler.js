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
import { RTMSError } from './utils/RTMSError.js';
import { sendDeferredEventSubscriptions } from './signalingSocketMessageHandler.js';


const keepAliveResponse = { msg_type: 13, timestamp: 0 };

function parseChatPayload(rawData) {
  if (rawData && typeof rawData === 'object') {
    return rawData;
  }

  if (typeof rawData !== 'string') {
    return { data: rawData ?? '' };
  }

  try {
    return JSON.parse(rawData);
  } catch {
    // Keep compatibility with older servers that sent plain UTF-8 chat text.
    return { data: rawData };
  }
}

export function handleMediaMessage(data, {
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

      case 4: // DATA_HAND_SHAKE_RESP
        FileLogger.log(
          `[Media] [${conn.rtmsType},${meetingUuid},${streamId}] Handshake response (${mediaType}): status=${msg.status_code} (${getRtmsStatusCode(msg.status_code)})`
        );

        if (msg.status_code === 0) {
          // Handshake successful - notify signaling socket
          signalingSocket.send(JSON.stringify({
            msg_type: 7,
            rtms_stream_id: streamId
          }));

          // Set state for this media type socket
          if (mediaType && conn.media[mediaType]) {
            conn.media[mediaType].state = 'streaming';
          }

          if ((mediaType === 'video' || mediaType === 'all') && conn.pendingEventSubscriptionPayload && !conn.eventSubscriptionsSent) {
            sendDeferredEventSubscriptions(conn, signalingSocket, meetingUuid, streamId);
          }
        } else {
          // Handshake failed - emit RTMSError
          const error = RTMSError.fromZoomStatus(msg.status_code, {
            meetingId: meetingUuid,
            streamId
          });
          FileLogger.error(`[Media] [${conn.rtmsType},${meetingUuid},${streamId}] ${error.toShortString()}`);

          if (['auth', 'security', 'request', 'meeting', 'stream'].includes(error.category)) {
            conn.shouldReconnect = false;
            FileLogger.warn(`[Media] [${conn.rtmsType},${meetingUuid},${streamId}] Disabling reconnect for non-retryable status ${msg.status_code}`);
          }

          emit('error', error);
        }
        break;

      case 12: // KEEP_ALIVE_REQ
        if (mediaType && conn.media[mediaType]) {
          conn.media[mediaType].lastKeepAlive = Date.now();
        }
        keepAliveResponse.timestamp = msg.timestamp;
        mediaWs.send(JSON.stringify(keepAliveResponse));
        break;

      case 14: // AUDIO
        if (msg.content?.data) {
          const { user_id, user_name, data: audioData, timestamp } = msg.content;
          const buffer = Buffer.from(audioData, 'base64');
          
          processAudio({
            buffer,
            userId: user_id,
            userName: user_name,
            timestamp,
            rtmsId: meetingUuid,
            meetingId: meetingUuid,
            streamId,
            productType: conn.rtmsType
          }, emit, conn.audioFiller);
        }
        break;

      case 15: // VIDEO
        if (msg.content?.data) {
          const { user_id, user_name, data: videoData, timestamp } = msg.content;
          const buffer = Buffer.from(videoData, 'base64');
          
          processVideo({
            buffer,
            userId: user_id,
            userName: user_name,
            timestamp,
            rtmsId: meetingUuid,
            meetingId: meetingUuid,
            streamId,
            productType: conn.rtmsType
          }, emit, conn.videoFiller);
        }
        break;

      case 16: // SHARESCREEN
        if (msg.content?.data) {
          const { user_id, user_name, data: shareData, timestamp } = msg.content;
          const buffer = Buffer.from(shareData, 'base64');
          
          processSharescreen({
            buffer,
            userId: user_id,
            userName: user_name,
            timestamp,
            rtmsId: meetingUuid,
            meetingId: meetingUuid,
            streamId,
            productType: conn.rtmsType
          }, emit);
        }
        break;

      case 17: // TRANSCRIPT
        if (msg.content?.data) {
          const { user_id, user_name, data: transcriptData, timestamp, start_time, end_time, language, attribute } = msg.content;
          
          processTranscript({
            text: transcriptData,
            userId: user_id,
            userName: user_name,
            timestamp,
            rtmsId: meetingUuid,
            meetingId: meetingUuid,
            streamId,
            productType: conn.rtmsType,
            startTime: start_time,
            endTime: end_time,
            language,
            attribute
          }, emit);
        }
        break;

      case 18: // CHAT
        if (msg.content?.data) {
          const { user_id, user_name, data: rawChatData, timestamp } = msg.content;
          const parsedChatData = parseChatPayload(rawChatData);
          const chatData = {
            ...msg.content,
            ...(parsedChatData && typeof parsedChatData === 'object' ? parsedChatData : {})
          };
          const sender = chatData.sender || {};
          const receiver = chatData.receiver || null;
          const resolvedUserId = sender.user_id ?? sender.userId ?? chatData.user_id ?? chatData.userId ?? user_id;
          const resolvedUserName = sender.user_name ?? sender.userName ?? chatData.user_name ?? chatData.userName ?? user_name;

          processChat({
            text: typeof chatData.data === 'string' ? chatData.data : String(chatData.data ?? ''),
            data: chatData,
            rawData: rawChatData,
            chatSession: chatData.chat_session || null,
            operationType: chatData.operation_type ?? null,
            messageId: chatData.message_id || null,
            parentMessageId: chatData.parent_message_id || null,
            sender,
            receiver,
            files: chatData.files || [],
            deleteFileIdList: chatData.delete_file_id_list || [],
            userId: resolvedUserId,
            userName: resolvedUserName,
            timestamp,
            rtmsId: meetingUuid,
            meetingId: meetingUuid,
            streamId,
            productType: conn.rtmsType
          }, emit);
        }
        break;

      default:
        // Unknown message type - ignore silently
        break;
    }
  } catch (err) {
    FileLogger.error(`[Media] Failed to parse message: ${err.message}`);
  }
}
