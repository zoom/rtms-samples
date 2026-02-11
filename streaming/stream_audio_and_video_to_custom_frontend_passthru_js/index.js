// Import necessary libraries
import express from 'express';
import crypto from 'crypto';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';

import { startLocalTranscoding } from './localTranscodedStreamer.js';

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

// 🆕 Serve the static files from the /public folder
app.use(express.static('public'));

// 🆕 CORS headers for HLS
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    next();
});

// Map to keep track of active WebSocket connections and audio chunks
const activeConnections = new Map();

const RECONNECT_DELAY = 3000;
const MAX_DUPLICATE_SIGNAL_RETRIES = Number(process.env.MAX_DUPLICATE_SIGNAL_RETRIES || 3);
const INITIAL_DUPLICATE_SIGNAL_RETRY_DELAY_MS = Number(process.env.INITIAL_DUPLICATE_SIGNAL_RETRY_DELAY_MS || 1500);


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

    // Handle RTMS started event
    if (event === 'meeting.rtms_started') {
        console.log('RTMS Started event received');
        const { meeting_uuid, rtms_stream_id, server_urls } = payload;
        connectToSignalingWebSocket(meeting_uuid, rtms_stream_id, server_urls);
    }

    // Handle RTMS stopped event
    if (event === 'meeting.rtms_stopped') {
        console.log('RTMS Stopped event received');
        const { rtms_stream_id } = payload;
        stopStreaming(rtms_stream_id);
    }
});

// 🆕 Route to serve the player page
app.get('/player', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <title>Live Stream</title>
        </head>
        <body>
            <h2>Live Stream</h2>
            <video id="videoPlayer" width="720" height="480" controls autoplay></video>

            <script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
            <script>
                if (Hls.isSupported()) {
                    var video = document.getElementById('videoPlayer');
                    var hls = new Hls();
                    hls.loadSource('/hls/stream.m3u8');
                    hls.attachMedia(video);
                    hls.on(Hls.Events.MANIFEST_PARSED, function () {
                        video.play();
                    });
                } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
                    video.src = '/hls/stream.m3u8';
                    video.addEventListener('loadedmetadata', function () {
                        video.play();
                    });
                } else {
                    alert('Your browser does not support HLS playback.');
                }
            </script>
        </body>
        </html>
    `);
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

// Function to connect to the signaling WebSocket server
function connectToSignalingWebSocket(meetingUuid, streamId, serverUrl) {
    console.log(`Connecting to signaling WebSocket for stream ${streamId}`);

    const existingConn = activeConnections.get(streamId);
    if (existingConn && existingConn.signaling) {
        const existingState = existingConn.signaling.readyState;
        if (existingState === WebSocket.CONNECTING || existingState === WebSocket.OPEN) {
            console.warn(`[Signaling] Already connected/connecting for stream ${streamId}. Skipping duplicate connect.`);
            return;
        }
    }
    if (existingConn && existingConn._signalingHandshakeInFlight) {
        console.warn(`[Signaling] Handshake already in flight for stream ${streamId}. Skipping duplicate connect.`);
        return;
    }
    if (existingConn && existingConn._signalingReconnectTimer) {
        clearTimeout(existingConn._signalingReconnectTimer);
        existingConn._signalingReconnectTimer = null;
    }

    const ws = new WebSocket(serverUrl);

    // Store connection keyed by streamId
    if (!activeConnections.has(streamId)) {
        activeConnections.set(streamId, { shouldReconnect: true });
    }
    const conn = activeConnections.get(streamId);
    conn.signaling = ws;
    conn.meetingUuid = meetingUuid;
    conn.streamId = streamId;
    conn.serverUrl = serverUrl;
    if (typeof conn._duplicateSignalRetryCount !== 'number') conn._duplicateSignalRetryCount = 0;

    ws.on('open', () => {
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
        };
        conn._signalingHandshakeInFlight = true;
        ws.send(JSON.stringify(handshake));
        console.log('Sent handshake to signaling server');

       
    });

    ws.on('message', (data) => {
        const msg = JSON.parse(data);
        console.log('Signaling Message:', JSON.stringify(msg, null, 2));

        // Handle successful handshake response
        if (msg.msg_type === 2 && msg.status_code === 0) { // SIGNALING_HAND_SHAKE_RESP
            conn._signalingHandshakeInFlight = false;
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
            if (
                msg.status_code === 17 &&
                String(msg.reason || '').toLowerCase().includes('duplicate signal request') &&
                conn.shouldReconnect
            ) {
                if (conn._duplicateSignalRetryCount < MAX_DUPLICATE_SIGNAL_RETRIES) {
                    const delay = INITIAL_DUPLICATE_SIGNAL_RETRY_DELAY_MS * (2 ** conn._duplicateSignalRetryCount);
                    conn._duplicateSignalRetryCount += 1;
                    if (conn._duplicateSignalRetryTimer) clearTimeout(conn._duplicateSignalRetryTimer);
                    conn._duplicateSignalRetryTimer = setTimeout(() => {
                        conn._duplicateSignalRetryTimer = null;
                        connectToSignalingWebSocket(conn.meetingUuid, streamId, conn.serverUrl);
                    }, delay);
                    console.warn(`[Signaling] Duplicate signal request for stream ${streamId}, retrying in ${delay}ms`);
                } else {
                    console.error(`[Signaling] Duplicate signal retries exhausted for stream ${streamId}`);
                }
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
        const conn = activeConnections.get(streamId);
        if (conn) conn._signalingHandshakeInFlight = false;
        console.error('Signaling socket error:', err);
    });

    ws.on('close', () => {
        console.log('Signaling socket closed');
        const conn = activeConnections.get(streamId);
        if (conn) {
            conn._signalingHandshakeInFlight = false;
            delete conn.signaling;
            if (conn.shouldReconnect) {
                console.log(`🔄 Signaling reconnecting in ${RECONNECT_DELAY}ms...`);
                conn._signalingReconnectTimer = setTimeout(() => {
                    conn._signalingReconnectTimer = null;
                    if (conn.shouldReconnect) {
                        connectToSignalingWebSocket(conn.meetingUuid, streamId, conn.serverUrl);
                    }
                }, RECONNECT_DELAY);
            }
        }
    });
}

function connectToMediaWebSocket(mediaUrl, meetingUuid, streamId, signalingSocket) {
    console.log(`Connecting to media WebSocket at ${mediaUrl}`);

    const { videoStream, audioStream, ffmpeg } = startLocalTranscoding();

    const conn = activeConnections.get(streamId);
    conn.videoStream = videoStream;
    conn.audioStream = audioStream;
    conn.ffmpegProcess = ffmpeg;
    conn.mediaUrl = mediaUrl;

    const mediaWs = new WebSocket(mediaUrl, { rejectUnauthorized: false });
    conn.media = mediaWs;

    mediaWs.on('open', () => {
        const signature = generateSignature(CLIENT_ID, meetingUuid, streamId, CLIENT_SECRET);
        const handshake = {
            msg_type: 3, 
            protocol_version: 1,
            meeting_uuid: meetingUuid,
            rtms_stream_id: streamId,
            signature,
            media_type: 32,
            payload_encryption: false,
            media_params: {
              audio: {
                content_type: 1,
                sample_rate: 1,
                channel: 1,
                codec: 1,
                data_opt: 1,
                send_rate: 100
              },
              video: {
                codec: 7, //H264
                resolution: 2,
                fps: 25
              }
            }
        };
        mediaWs.send(JSON.stringify(handshake));
        console.log('✅ Media WebSocket connected and handshake sent');
    });

    mediaWs.on('message', (data) => {
        try {
            const msg = JSON.parse(data.toString());

            if (msg.msg_type === 4 && msg.status_code === 0) {
                signalingSocket.send(JSON.stringify({
                    msg_type: 7, 
                    rtms_stream_id: streamId,
                }));
                console.log('✅ Media handshake successful');
            }

            if (msg.msg_type === 12) {
                mediaWs.send(JSON.stringify({
                    msg_type: 13,
                    timestamp: msg.timestamp,
                }));
            }

            if (msg.msg_type === 14 && msg.content?.data) {
                const { data: audioData } = msg.content;
                const buffer = Buffer.from(audioData, 'base64');
                const conn = activeConnections.get(streamId);

                if (conn?.audioStream?.writable) {
                    conn.audioStream.write(buffer);
                } else {
                    console.warn('⚠️ Audio stream not writable');
                }
            }

            if (msg.msg_type === 15 && msg.content?.data) {
                const { data: videoData } = msg.content;
                const buffer = Buffer.from(videoData, 'base64');
                const conn = activeConnections.get(streamId);

                if (conn?.videoStream?.writable) {
                    conn.videoStream.write(buffer);
                } else {
                    console.warn('⚠️ Video stream not writable');
                }
            }
        } catch (err) {
            console.error('❌ Error processing media message:', err);
        }
    });

    mediaWs.on('error', (err) => {
        console.error('❌ Media WebSocket error:', err);
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

    if (conn.media) {
        conn.media.close();
    }
    if (conn.signaling) {
        conn.signaling.close();
    }
    if (conn.ffmpegProcess) {
        console.log('🛑 Stopping FFmpeg process');
        conn.ffmpegProcess.kill('SIGINT');
    }

    activeConnections.delete(streamId);
    console.log(`🛑 Stopped streaming for stream: ${streamId}`);
}

// Start the server and listen on the specified port
app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
    console.log(`Webhook endpoint available at http://localhost:${port}${WEBHOOK_PATH}`);
    console.log(`Player available at http://localhost:${port}/player`);
});
