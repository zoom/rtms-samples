import express from 'express';
import crypto from 'crypto';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';

import { startIVSStream } from './ivsLiveStreamer.js';
import { readFileSync } from 'fs';

// Load environment variables from a .env file
dotenv.config();

// Load complete denomination buffers (1,2,4,8,16,32,40,80,160,320ms keyframes for gap filling)
const denominationBuffers = {
  1: readFileSync('./black_video_1ms_keyframe.h264'),
  2: readFileSync('./black_video_2ms_keyframe.h264'),
  4: readFileSync('./black_video_4ms_keyframe.h264'),
  8: readFileSync('./black_video_8ms_keyframe.h264'),
  16: readFileSync('./black_video_16ms_keyframe.h264'),
  32: readFileSync('./black_video_32ms_keyframe.h264'),
  40: readFileSync('./black_video_40ms_keyframe.h264'),
  42: readFileSync('./black_video_42ms_keyframe.h264'),
  80: readFileSync('./black_video_80ms_keyframe.h264'),
  160: readFileSync('./black_video_160ms_keyframe.h264'),
  320: readFileSync('./black_video_320ms_keyframe.h264'),
};

// Use 40ms buffer as the continuous injection buffer (25fps)
const blackVideoBuffer40ms = readFileSync('./black_video_40ms_keyframe.h264');

console.log(`🎥 Loaded denomination buffers for precise timing (${Object.keys(denominationBuffers).length} denominations)`);
Object.entries(denominationBuffers).forEach(([ms, buffer]) =>
  console.log(`  ${ms}ms: ${buffer.length} bytes`));
console.log(`🎥 Loaded ${blackVideoBuffer40ms.length} bytes continuous 40ms buffer (25fps)`);

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

    const { videoStream, audioStream, ffmpeg } = startIVSStream();

    const conn = activeConnections.get(streamId);
    conn.streams = { videoStream, audioStream };
    conn.ffmpegProcess = ffmpeg;
    conn.mediaUrl = mediaUrl;

    // Initialize timing variables for keep-alive
    let lastVideoTime = Date.now();
    let videoMuteState = "active"; // "active" | "continuous_mute"
    let firstMediaReceived = false; // Wait for first audio/video before starting timers
    let videoMuteDetectionTimer;
    let continuousStartTime = null; // Track when continuous injection started
    let loopCount = 0; // Count continuous injection loops
    let timeDifferentAccumulate =0;

    // Function to start keep-alive timers after first media is received
    const startKeepAliveTimers = () => {
        if (firstMediaReceived) return; // Already started

        console.log('📡 First media received - starting keep-alive timers');
        firstMediaReceived = true;

        // Video keep-alive system
        // Check every 40ms for mute detection and injection

        videoMuteDetectionTimer = setInterval(() => {
          const now = Date.now();
          const gap = now - lastVideoTime;
          if (gap > 320 && videoMuteState === "active") {
            // First time mute detected - inject frames to cover the gap
            const framesToInject = Math.ceil(gap / 40);
            if (videoStream.writable) {
              for (let i = 0; i < framesToInject; i++) {
                videoStream.write(denominationBuffers[40]);
              }
              console.log(`🎥 Video mute detected: injected ${framesToInject} × 40ms frames to cover ${gap}ms gap`);
            }
            videoMuteState = "continuous_mute";
            continuousStartTime = now; // Start tracking continuous injection timing
            loopCount = 0; // Reset loop count
          } else if (videoMuteState === "continuous_mute") {
            // Continuous injection - inject 1 frame of 40ms every 40ms
            if (videoStream.writable) {
              videoStream.write(denominationBuffers[40]);
            }

            // Timing accuracy check every 250 loops (250 * 40ms = 10 seconds)
            loopCount++;
            if (loopCount >= 250) {
              const expectedTime = 40 * 250; // 10000ms
              const actualTime = now - continuousStartTime;
              const timeDifference = actualTime - expectedTime;
              timeDifferentAccumulate+=timeDifference;
              
              if (timeDifferentAccumulate > 40) {
                // Timer is running slow, inject additional frames to compensate
                const quotient = Math.floor(timeDifferentAccumulate / 40);
        
                const additionalFrames = quotient;
                if (additionalFrames > 0 && videoStream.writable) {
                  for (let i = 0; i < additionalFrames; i++) {
                    videoStream.write(denominationBuffers[40]);
                  }
                  console.log(`⏰ Timing compensation: injected ${additionalFrames} additional frames (${timeDifferentAccumulate}ms drift)`);
                  timeDifferentAccumulate %= 40;
                }
              }

              // Reset timing tracking
              continuousStartTime = now;
              loopCount = 0;
            }
        }
    }, 40);

        activeConnections.get(streamId).videoMuteDetectionTimer = videoMuteDetectionTimer;
    };

    activeConnections.get(streamId).videoMuteDetectionTimer = videoMuteDetectionTimer;

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
      if (msg.msg_type === 12) { // KEEP_ALIVE_REQ
            const keepAliveResponse = {
                msg_type: 13, // KEEP_ALIVE_RESP
                timestamp: msg.timestamp,
            };
            console.log('Responding to Signaling KEEP_ALIVE_REQ:', keepAliveResponse);
            mediaWs.send(JSON.stringify(keepAliveResponse));
        }
            if (msg.msg_type === 14 && msg.content?.data) {
                const { data: audioData } = msg.content;
                const buffer = Buffer.from(audioData, 'base64');

                startKeepAliveTimers();

                const conn = activeConnections.get(streamId);
                if (conn?.streams?.audioStream?.writable) {
                    conn.streams.audioStream.write(buffer);
                }
            }

            if (msg.msg_type === 15 && msg.content?.data) {
                const { data: videoData } = msg.content;
                const buffer = Buffer.from(videoData, 'base64');

                startKeepAliveTimers();

                const conn = activeConnections.get(streamId);
                lastVideoTime = Date.now();

                if (videoMuteState !== "active") {
                    videoMuteState = "active";
                    console.log('🎥 Video returned: Resetting mute detection state to active');
                }

                if (conn?.streams?.videoStream?.writable) {
                    conn.streams.videoStream.write(buffer);
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
        conn.media.removeAllListeners('error');
        conn.media.close();
    }
    if (conn.signaling) {
        conn.signaling.close();
    }

    if (conn.videoMuteDetectionTimer) {
        clearInterval(conn.videoMuteDetectionTimer);
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
});
