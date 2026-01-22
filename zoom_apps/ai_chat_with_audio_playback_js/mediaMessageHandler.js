import { chatWithOpenRouter, chatWithMultipleModels, contextualSynthesisFromMultipleModels } from './chatWithOpenrouter.js';
import {
  logHandshakeResponse,
  logRtmsSessionState,
  logRtmsStreamState,
  logRtmsStopReason,
  logRtmsStatusCode
} from './utils/rtmsEventLookup.js';


export async function handleMediaMessage(data, {
  conn,
  mediaWs,
  signalingSocket,
  meetingUuid,
  streamId,
  sharedServices
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
        console.log("[Media] case 12");
        conn.media.lastKeepAlive = Date.now();
        //console.log(msg.timestamp);
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
          const { user_id, user_name, data: audioData } = msg.content;
          const buffer = Buffer.from(audioData, 'base64');
          //console.log('Audio data received');
          // You can add processing logic here

        }
        break;

      // {
      //   "msg_type": 15,
      //   "content": {
      //     "user_id": 16778240,
      //     "user_name": "John Smith",
      //     "data": "xxxxxxxxxxxxxx=="
      //   }
      // }
      case 15: // VIDEO
        if (msg.content?.data) {
          const { user_id, user_name, data: videoData, timestamp } = msg.content;
          const buffer = Buffer.from(videoData, 'base64');
          //console.log('Video data received');
        }
        break;

      // {
      //   "msg_type": 16
      //   "content": {
      //     "user_id": 16778240,
      //     "user_name": "John Smith",
      //     "data": "xxxxxxxxxxxxxx=="
      //   }
      // }
      case 16: // SHARESCREEN
        if (msg.content?.data) {
          const { user_id, user_name, data: shareData, timestamp } = msg.content;
          const buffer = Buffer.from(shareData, 'base64');
          console.log('Sharescreen data received');
        }
        break;


      // {
      //   "msg_type": 17, 
      //   "content": {
      //     "user_id": 19778240,
      //     "user_name": "John Smith",
      //     "timestamp": 1727384349000,
      //     "data": "Hi, hello world!"
      //   }
      // }
      case 17:   // TRANSCRIPT
        if (msg.content?.data) {
          // console.log('Transcript data received');
          // debugging
          console.log('Media JSON Message:', JSON.stringify(msg, null, 2));
          let { user_id, user_name, data, timestamp } = msg.content;

          try {
            // Get response from OpenRouter
            const aiResponse = await chatWithOpenRouter(data);
            console.log('🤖 AI Response:', aiResponse);

            // Debug logging for shared services
            console.log('🔍 Debug - sharedServices available:', !!sharedServices);
            console.log('🔍 Debug - textToSpeech function:', !!sharedServices?.textToSpeech);
            console.log('🔍 Debug - broadcastToFrontendClients function:', !!sharedServices?.broadcastToFrontendClients);

            // Send text response to frontend clients first
            if (sharedServices?.broadcastToFrontendClients) {
              sharedServices.broadcastToFrontendClients({
                type: 'text',
                data: aiResponse,
                metadata: {
                  source: 'ai_response',
                  originalTranscript: data,
                  user_name: user_name,
                  timestamp: timestamp
                }
              });
              console.log('✅ AI response text sent to frontend clients');
            }

            // Convert AI response to speech using Deepgram
            if (sharedServices?.textToSpeech && sharedServices?.broadcastToFrontendClients) {
              console.log('🎤 Converting AI response to speech...');
              const base64Audio = await sharedServices.textToSpeech(aiResponse);
              
              // Send audio to frontend clients
              sharedServices.broadcastToFrontendClients({
                type: 'audio',
                data: base64Audio,
                metadata: {
                  source: 'ai_response',
                  originalTranscript: data,
                  aiResponse: aiResponse,
                  user_name: user_name,
                  timestamp: timestamp
                }
              });
              
              console.log('✅ AI response audio sent to frontend clients');
            } else {
              console.warn('⚠️ Shared services not available for text-to-speech');
              if (!sharedServices) {
                console.warn('   - sharedServices is null/undefined');
              } else {
                console.warn('   - textToSpeech available:', !!sharedServices.textToSpeech);
                console.warn('   - broadcastToFrontendClients available:', !!sharedServices.broadcastToFrontendClients);
              }
            }
          } catch (error) {
            console.error('❌ Error processing transcript:', error);
          }
        }
        break;

      case 18: // CHAT
        if (msg.content?.data) {
          console.log('Chat data received');
          // Handle chat
        }
        break;

      default:
        // Unknown message type
        break;
    }
  } catch (err) {
    console.error('Failed to parse message:', data.toString('hex'));
  }
}
