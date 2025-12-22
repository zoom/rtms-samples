import WebSocket from 'ws';
import { concatBuffers } from '../utils/audio.js';
import { logRtmsStatusCode, logRtmsStopReason } from '../utils/rtms.js';
import type { SampleAudioPacket, Connection } from '../types.js';

interface HandleMediaMessageParams {
    conn: Connection;
    mediaWs: WebSocket;
    signalingSocket: WebSocket;
    streamId: string;
}

// Media message handler
export function handleMediaMessage(data: Buffer, params: HandleMediaMessageParams): void {
    const { conn, mediaWs, signalingSocket, streamId } = params;

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
                    const { data: audioData } = msg.content as SampleAudioPacket['content'];
                    const buffer = Buffer.from(audioData, 'base64');
                    // console.log('Audio data received from ' + user_id + ":" + user_name);
                    void concatBuffers(buffer);
                }
                break;

            case 15: // VIDEO
                if (msg.content?.data) {
                    const { user_id, user_name } = msg.content;
                    console.log('Video data received from ' + user_id + ":" + user_name);
                }
                break;

            case 16: // SHARESCREEN
                if (msg.content?.data) {
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
    } catch {
        console.error('Failed to parse message:', data.toString('hex'));
    }
}

