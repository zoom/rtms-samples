import WebSocket from 'ws';
import { generateSignature } from '../utils/rtms.js';
import { handleMediaMessage } from '../handlers/media.js';
import { connectToSignalingWebSocket } from './signaling.js';
import type { Connection, ActiveConnections } from '../types.js';

// Connect to media WebSocket
export function connectToMediaWebSocket(
    mediaUrl: string,
    sessionID: string,
    streamId: string,
    signalingSocket: WebSocket,
    conn: Connection,
    clientId: string,
    clientSecret: string,
    activeConnections: ActiveConnections
): void {
    console.log(`[Media] Connecting for video session ${sessionID}...`);

    const wsOptions = {
        rejectUnauthorized: false
    };

    console.log(`Media WebSocket SSL verification disabled`);

    const mediaWs = new WebSocket(mediaUrl, [], wsOptions);
    conn.media.socket = mediaWs;
    conn.media.state = 'connecting';
    console.log(`[Media] WebSocket instance created successfully, SSL verification disabled`);

    mediaWs.on('open', () => {
        if (!conn.shouldReconnect) {
            console.warn(`[Media] Aborting open: RTMS stopped for ${sessionID}`);
            mediaWs.close();
            return;
        }

        const signature = generateSignature(sessionID, streamId, clientId, clientSecret);

        const handshakeMsg = {
            msg_type: 3, // DATA_HAND_SHAKE_REQ
            protocol_version: 1,
            meeting_uuid: sessionID,
            session_id: sessionID,
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
                    send_rate: 1000 //in Milliseconds
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
            streamId
        });
    });

    mediaWs.on('close', async () => {
        console.warn(`[Media] Closed for ${sessionID}`);
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
                    sessionID,
                    streamId,
                    conn.signaling.socket!,
                    conn,
                    clientId,
                    clientSecret,
                    activeConnections
                );
            }, 3000);
        } else {
            console.warn(`[Media] Signaling not ready. Restarting both sockets...`);
            connectToSignalingWebSocket(
                sessionID,
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

