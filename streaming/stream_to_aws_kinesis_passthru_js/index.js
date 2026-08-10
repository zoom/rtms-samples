const express = require('express');
const crypto = require('crypto');
const WebSocket = require('ws');
const dotenv = require('dotenv');
const fs = require('fs');
const { exec } = require('child_process');
const { promisify } = require('util');


// choose either GStreamer or PutMedia producer 

// Custom KVS GStreamer functions
// const { startStream,sendAudioBuffer, sendVideoBuffer } = require('./kvs_gstreamer_stream_audio_and_video_with_ffmpeg.js');
// Custom KVS PutMedia producer
const { startStream, sendAudioBuffer, sendVideoBuffer } = require('./kvs_putmedia_producer_stream_audio_and_video_with_ffmpeg.js');

// Load environment variables from a .env file
dotenv.config();

const app = express();
const port = process.env.PORT || 3000;
const execAsync = promisify(exec);

const ZOOM_SECRET_TOKEN = process.env.ZOOM_SECRET_TOKEN;
const CLIENT_ID = process.env.ZOOM_CLIENT_ID;
const CLIENT_SECRET = process.env.ZOOM_CLIENT_SECRET;
const WEBHOOK_PATH = process.env.WEBHOOK_PATH || '/webhook';

// Middleware to parse JSON bodies in incoming requests
app.use(express.json());

const activeConnections = new Map();
const RECONNECT_DELAY = 3000;
const MAX_DUPLICATE_SIGNAL_RETRIES = Number(process.env.MAX_DUPLICATE_SIGNAL_RETRIES || 3);
const INITIAL_DUPLICATE_SIGNAL_RETRY_DELAY_MS = Number(process.env.INITIAL_DUPLICATE_SIGNAL_RETRY_DELAY_MS || 1500);

function getOrCreateConnection(streamId) {
    if (!activeConnections.has(streamId)) {
        activeConnections.set(streamId, {
            shouldReconnect: true,
            _duplicateSignalRetryCount: 0,
            _signalingConnectLocked: false,
            _signalingConnectSocket: null,
        });
    }

    return activeConnections.get(streamId);
}

function clearTimer(timer) {
    if (timer) {
        clearTimeout(timer);
    }
}

function clearSignalingTimers(conn) {
    clearTimer(conn._signalingReconnectTimer);
    clearTimer(conn._duplicateSignalRetryTimer);
    conn._signalingReconnectTimer = null;
    conn._duplicateSignalRetryTimer = null;
}

function releaseSignalingConnectLock(conn, socket) {
    if (conn._signalingConnectSocket === socket) {
        conn._signalingConnectLocked = false;
        conn._signalingConnectSocket = null;
    }
}

function closeSocketQuietly(socket) {
    if (!socket) return;

    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close();
    }
}

// Handle POST requests to the webhook endpoint
app.post(WEBHOOK_PATH, (req, res) => {
    // Respond with HTTP 200 status
    res.sendStatus(200);
    console.log('RTMS Webhook received:', JSON.stringify(req.body, null, 2));
    const { event, payload } = req.body;

    // Handle URL validation event
    if (event === 'endpoint.url_validation' && payload?.plainToken) {
        // Generate a hash for URL validation using the plainToken and a secret token
        const hash = crypto
            .createHmac('sha256', ZOOM_SECRET_TOKEN)
            .update(payload.plainToken)
            .digest('hex');
        console.log('Responding to URL validation challenge');
        return res.json({
            plainToken: payload.plainToken,
            encryptedToken: hash,
        });
    }

    if (event === 'meeting.rtms_started') {
        console.log('RTMS Started event received');
        const { meeting_uuid, rtms_stream_id, server_urls } = payload;
        connectToSignalingWebSocket(meeting_uuid, rtms_stream_id, server_urls);
    }

    if (event === 'meeting.rtms_stopped') {
        console.log('RTMS Stopped event received');
        const { rtms_stream_id } = payload;
        stopStreaming(rtms_stream_id);
    }
});

// Function to generate a signature for authentication
function generateSignature(CLIENT_ID, meetingUuid, streamId, CLIENT_SECRET) {
    console.log('Generating signature with parameters:');
    console.log('meetingUuid:', meetingUuid);
    console.log('streamId:', streamId);

    // Create a message string and generate an HMAC SHA256 signature
    const message = `${CLIENT_ID},${meetingUuid},${streamId}`;
    return crypto.createHmac('sha256', CLIENT_SECRET).update(message).digest('hex');
}

function connectToSignalingWebSocket(meetingUuid, streamId, serverUrl) {
    console.log(`Connecting to signaling WebSocket for stream ${streamId}`);

    const conn = getOrCreateConnection(streamId);
    conn.meetingUuid = meetingUuid;
    conn.streamId = streamId;
    conn.serverUrl = serverUrl;

    if (conn._signalingConnectLocked) {
        console.warn(`[Signaling] Connect already in progress for stream ${streamId}. Skipping duplicate connect.`);
        return;
    }

    if (conn.signaling) {
        const existingState = conn.signaling.readyState;
        if (existingState !== WebSocket.CLOSED) {
            console.warn(`[Signaling] Already connected/connecting for stream ${streamId}. Skipping duplicate connect.`);
            return;
        }
    }

    clearSignalingTimers(conn);
    conn._signalingConnectLocked = true;

    const ws = new WebSocket(serverUrl);
    conn._signalingConnectSocket = ws;
    conn.signaling = ws;

    ws.on('open', () => {
        if (conn.signaling !== ws) {
            console.warn(`[Signaling] Opened stale socket for stream ${streamId}; closing it.`);
            closeSocketQuietly(ws);
            return;
        }

        console.log(`Signaling WebSocket connection opened for stream ${streamId}`);
        const signature = generateSignature(
            CLIENT_ID,
            meetingUuid,
            streamId,
            CLIENT_SECRET
        );

        // Send handshake message to the signaling server
        const handshake = {
            msg_type: 1, // SIGNALING_HAND_SHAKE_REQ
            protocol_version: 1,
            meeting_uuid: meetingUuid,
            rtms_stream_id: streamId,
            sequence: Math.floor(Math.random() * 1e9),
            signature,
            buffer_data: false,
        };
        conn._signalingHandshakeInFlight = true;
        ws.send(JSON.stringify(handshake));
        console.log('Sent handshake to signaling server');
    });

    ws.on('message', (data) => {
        if (conn.signaling !== ws) {
            console.warn(`[Signaling] Ignoring message from stale socket for stream ${streamId}.`);
            return;
        }

        const msg = JSON.parse(data);
        console.log('Signaling Message:', JSON.stringify(msg, null, 2));
        const isDuplicateSignalRequest = String(msg.reason || '').toLowerCase().includes('duplicate signal request');

        // Handle successful handshake response
        if (msg.msg_type === 2 && msg.status_code === 0) { // SIGNALING_HAND_SHAKE_RESP
            conn._signalingHandshakeInFlight = false;
            releaseSignalingConnectLock(conn, ws);
            conn._duplicateSignalRetryCount = 0;
            if (conn._duplicateSignalRetryTimer) {
                clearTimeout(conn._duplicateSignalRetryTimer);
                conn._duplicateSignalRetryTimer = null;
            }
            const mediaUrl = msg.media_server?.server_urls?.all;
            if (mediaUrl) {
                connectToMediaWebSocket(mediaUrl, meetingUuid, streamId, ws);
            }
        } else if (msg.msg_type === 2) {
            conn._signalingHandshakeInFlight = false;
            releaseSignalingConnectLock(conn, ws);
            if (isDuplicateSignalRequest && conn.shouldReconnect) {
                if (conn._duplicateSignalRetryCount < MAX_DUPLICATE_SIGNAL_RETRIES) {
                    const delay = INITIAL_DUPLICATE_SIGNAL_RETRY_DELAY_MS * (2 ** conn._duplicateSignalRetryCount);
                    conn._duplicateSignalRetryCount += 1;
                    if (conn._duplicateSignalRetryTimer) clearTimeout(conn._duplicateSignalRetryTimer);
                    conn._suppressNextSignalingCloseReconnect = ws;
                    conn._duplicateSignalRetryTimer = setTimeout(() => {
                        conn._duplicateSignalRetryTimer = null;
                        connectToSignalingWebSocket(conn.meetingUuid, streamId, conn.serverUrl);
                    }, delay);
                    closeSocketQuietly(ws);
                    console.warn(`[Signaling] Duplicate signal request for stream ${streamId} (status ${msg.status_code}), retrying in ${delay}ms`);
                } else {
                    console.error(`[Signaling] Duplicate signal retries exhausted for stream ${streamId} (status ${msg.status_code})`);
                }
            } else {
                conn._suppressNextSignalingCloseReconnect = ws;
                console.error(`[Signaling] Handshake failed for stream ${streamId}:`, msg);
                closeSocketQuietly(ws);
            }
        }

        // Respond to keep-alive requests
        if (msg.msg_type === 12) { // KEEP_ALIVE_REQ
            const keepAliveResponse = {
                msg_type: 13, // KEEP_ALIVE_RESP
                timestamp: msg.timestamp,
            };
            console.log('Responding to Signaling KEEP_ALIVE_REQ:', keepAliveResponse);
            ws.send(JSON.stringify(keepAliveResponse));
        }
    });

    ws.on('error', (err) => {
        const activeConn = activeConnections.get(streamId);
        if (activeConn) {
            activeConn._signalingHandshakeInFlight = false;
            releaseSignalingConnectLock(activeConn, ws);
        }
        console.error('Signaling socket error:', err);
    });

    ws.on('close', () => {
        console.log('Signaling socket closed');
        const activeConn = activeConnections.get(streamId);
        if (activeConn) {
            activeConn._signalingHandshakeInFlight = false;
            releaseSignalingConnectLock(activeConn, ws);

            if (activeConn.signaling === ws) {
                delete activeConn.signaling;
            }

            const suppressReconnect = activeConn._suppressNextSignalingCloseReconnect === ws;
            if (suppressReconnect) {
                activeConn._suppressNextSignalingCloseReconnect = null;
                return;
            }

            if (activeConn.shouldReconnect) {
                console.log(`🔄 Signaling reconnecting in ${RECONNECT_DELAY}ms...`);
                activeConn._signalingReconnectTimer = setTimeout(() => {
                    activeConn._signalingReconnectTimer = null;
                    if (activeConn.shouldReconnect) {
                        connectToSignalingWebSocket(activeConn.meetingUuid, streamId, activeConn.serverUrl);
                    }
                }, RECONNECT_DELAY);
            }
        }
    });
}

function connectToMediaWebSocket(mediaUrl, meetingUuid, streamId, signalingSocket) {
    console.log(`Connecting to media WebSocket at ${mediaUrl}`);

    const mediaWs = new WebSocket(mediaUrl, { rejectUnauthorized: false });

    const conn = activeConnections.get(streamId);
    conn.media = mediaWs;
    conn.mediaUrl = mediaUrl;



    mediaWs.on('open', () => {
        const signature = generateSignature(
            CLIENT_ID,
            meetingUuid,
            streamId,
            CLIENT_SECRET
        );
        const handshake = {
            msg_type: 3, // DATA_HAND_SHAKE_REQ
            protocol_version: 1,
            meeting_uuid: meetingUuid,
            rtms_stream_id: streamId,
            signature,
            media_type: 3, // AUDIO | VIDEO
            payload_encryption: false,
            media_params: {
                audio: {
                    content_type: 2,
                    sample_rate: 1,
                    channel: 1,
                    codec: 1,
                    data_opt: 1,
                    send_rate: 100
                },
                video: {
                    content_type: 3,
                    codec: 7, //H264
                    resolution: 2,
                    fps: 25
                }
            }
        };
        mediaWs.send(JSON.stringify(handshake));
    });

    mediaWs.on('message', (data) => {
        try {
            // Try to parse as JSON first
            const msg = JSON.parse(data.toString());
            // debugging
            //console.log('Media JSON Message:', JSON.stringify(msg, null, 2));

            // Handle successful media handshake
            if (msg.msg_type === 4 && msg.status_code === 0) { // DATA_HAND_SHAKE_RESP
                signalingSocket.send(
                    JSON.stringify({
                        msg_type: 7, // CLIENT_READY_ACK
                        rtms_stream_id: streamId,
                    })
                );
                console.log('Media handshake successful, sent start streaming request');
            }

            // Respond to keep-alive requests
            if (msg.msg_type === 12) { // KEEP_ALIVE_REQ
                mediaWs.send(
                    JSON.stringify({
                        msg_type: 13, // KEEP_ALIVE_RESP
                        timestamp: msg.timestamp,
                    })
                );
                console.log('Responded to Media KEEP_ALIVE_REQ');
            }

            // Handle audio data
            if (msg.msg_type === 14 && msg.content && msg.content.data) {
                let { user_id, user_name, data: audioData } = msg.content;
                let buffer = Buffer.from(audioData, 'base64');
                let timestamp = Date.now();  // Use server timestamp
                const metadata = { user_id, user_name, timestamp };
                console.log(buffer);
                //sendAudioBuffer(buffer);
              
            }
            // Handle video data
            if (msg.msg_type === 15 && msg.content && msg.content.data) {
                let { user_id, user_name, data: videoData } = msg.content;
                 let buffer = Buffer.from(videoData,'base64');
                let timestamp = Date.now();  // Use server timestamp
                const metadata = { user_id, user_name, timestamp };
                 console.log(buffer);
                //sendVideoBuffer(buffer);
                
            }
            // Handle transcript data
            if (msg.msg_type === 17 && msg.content && msg.content.data) {

            }
        } catch (err) {
            console.error('Error processing media message:', err);
        }
    });

    mediaWs.on('error', (err) => {
        console.error('Media socket error:', err);
    });

    mediaWs.on('close', () => {
        console.log('🛑 Media WebSocket closed');
        const conn = activeConnections.get(streamId);
        if (conn) {
            delete conn.media;
            if (conn.shouldReconnect && conn.signaling?.readyState === WebSocket.OPEN) {
                console.log(`🔄 Media reconnecting in ${RECONNECT_DELAY}ms...`);
                setTimeout(() => {
                    if (conn.shouldReconnect) {
                        connectToMediaWebSocket(conn.mediaUrl, conn.meetingUuid, streamId, conn.signaling);
                    }
                }, RECONNECT_DELAY);
            } else if (conn.shouldReconnect) {
                console.log('🔄 Signaling not ready, will reconnect media after signaling reconnects');
            }
        }
    });
}

function stopStreaming(streamId) {
    const conn = activeConnections.get(streamId);
    if (!conn) return;

    conn.shouldReconnect = false;
    conn._suppressNextSignalingCloseReconnect = conn.signaling || null;
    clearSignalingTimers(conn);
    releaseSignalingConnectLock(conn, conn._signalingConnectSocket);

    if (conn.media) {
        conn.media.close();
    }
    if (conn.signaling) {
        conn.signaling.close();
    }

    activeConnections.delete(streamId);
    console.log(`🛑 Stopped streaming for stream: ${streamId}`);
}

// Start the server and listen on the specified port
app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
    console.log(`Webhook endpoint available at http://localhost:${port}${WEBHOOK_PATH}`);

    //this is for putmedia producer
    //startStream();
});
