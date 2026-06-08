import express from 'express';
import crypto from 'crypto';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';

import { startYouTubeStream } from './youtubeLiveStreamer.js';
import { readFileSync } from 'fs';

// Load environment variables from a .env file
dotenv.config();

// Load buffer files into memory at startup
const silentAudioBuffer = readFileSync('./small_silent_audio.pcm');

// Load complete denomination buffers (1,2,4,8,16,32,40,80,160,320ms keyframes for gap filling)
const denominationBuffers = {
  1: readFileSync('./black_video_1ms_keyframe.h264'),
  2: readFileSync('./black_video_2ms_keyframe.h264'),
  4: readFileSync('./black_video_4ms_keyframe.h264'),
  8: readFileSync('./black_video_8ms_keyframe.h264'),
  16: readFileSync('./black_video_16ms_keyframe.h264'),
  32: readFileSync('./black_video_32ms_keyframe.h264'),
  40: readFileSync('./black_video_40ms_keyframe.h264'),
  80: readFileSync('./black_video_80ms_keyframe.h264'),
  160: readFileSync('./black_video_160ms_keyframe.h264'),
  320: readFileSync('./black_video_320ms_keyframe.h264'),
};

// Use 40ms buffer as the continuous injection buffer (25fps)
const blackVideoBuffer40ms = readFileSync('./black_video_40ms_keyframe.h264');

console.log(`🎵 Loaded ${silentAudioBuffer.length} bytes of silent audio buffer`);
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

    const { videoStream, audioStream, ffmpeg } = startYouTubeStream();

    const conn = activeConnections.get(streamId);
    conn.streams = { videoStream, audioStream };
    conn.ffmpegProcess = ffmpeg;
    conn.mediaUrl = mediaUrl;

    // Initialize timing variables for keep-alive
    let lastVideoTime = Date.now();
    let lastAudioTime = Date.now();
    let lastInjectionTime = Date.now(); // Track when we last injected frames
    let videoMuteState = "active"; // "active" | "first_mute" | "continuous_mute"
    let firstMediaReceived = false; // Wait for first audio/video before starting timers
    let audioKeepAliveTimer, videoMuteDetectionTimer, videoKeepAliveTimer;

    // Function to start keep-alive timers after first media is received
    const startKeepAliveTimers = () => {
        if (firstMediaReceived) return; // Already started

        console.log('📡 First media received - starting keep-alive timers');
        firstMediaReceived = true;

        // Audio: 100ms timer for occasional silence injection
        audioKeepAliveTimer = setInterval(() => {
            if (!activeConnections.has(streamId)) return;

            const now = Date.now();
            if (now - lastAudioTime > 100) {
                if (audioStream.writable) {
                    audioStream.write(silentAudioBuffer);
                    console.log(`🔇 Audio keep-alive: Injected ${silentAudioBuffer.length} bytes of silent audio`);
                }
            }
        }, 100);

        // Video: Two-tier keep-alive system
        // 1. Detection timer (500ms): detects mute + sends initial 500ms fill
        // 2. Continuous timer (40ms): sends 40ms frames for smooth stream during mute

        // Detection timer - conservative mute detection with binary denomination gap filling
        videoMuteDetectionTimer = setInterval(() => {
          const now = Date.now();
          if (now - lastVideoTime > 500 && videoMuteState === "active") {
            // First time mute detected - use binary denominations for exact gap filling
            const gapDuration = now - lastVideoTime; // Exact gap in ms (e.g. 527)

            // Calculate optimal denomination combination (greedy algorithm)
            const denominationOrder = [320, 160, 80, 40, 32, 16, 8, 4, 2, 1]; // Largest to smallest available denominations
            const denominationsToUse = [];

            let remainingGap = gapDuration;
            for (const denom of denominationOrder) {
              if (remainingGap >= denom) {
                const count = Math.floor(remainingGap / denom);
                denominationsToUse.push({ denom, count });
                remainingGap %= denom;
              }
            }

            // Inject the calculated denomination combination
            let totalInjected = 0;
            for (const { denom, count } of denominationsToUse) {
              for (let i = 0; i < count && videoStream.writable; i++) {
                if (denominationBuffers[denom]) {
                  videoStream.write(denominationBuffers[denom]);
                  totalInjected++;
                }
              }
            }

            // Update last injection time
            lastInjectionTime = Date.now();

            console.log(`🎥 Video mute detected: ${gapDuration}ms gap → injected ${totalInjected} denomination frames`);
            if (denominationsToUse.length > 0) {
              const composition = denominationsToUse.map(d => `${d.count}×${d.denom}ms`).join(' + ');
              console.log(`🎥 Gap composition: ${composition} = ${denominationsToUse.reduce((sum, d) => sum + d.denom * d.count, 0)}ms`);
            }

            videoMuteState = "continuous_mute";
            console.log(`🎥 Switched to continuous 40ms binary denomination injection mode`);
          }
        }, 500); // Check every 500ms for mute detection

        // No continuous keep-alive timer - only use detection timer (500ms)

        activeConnections.get(streamId).audioKeepAliveTimer = audioKeepAliveTimer;
        activeConnections.get(streamId).videoMuteDetectionTimer = videoMuteDetectionTimer;
        activeConnections.get(streamId).videoKeepAliveTimer = videoKeepAliveTimer;
    };

    activeConnections.get(streamId).audioKeepAliveTimer = audioKeepAliveTimer;
    activeConnections.get(streamId).videoMuteDetectionTimer = videoMuteDetectionTimer;
    activeConnections.get(streamId).videoKeepAliveTimer = videoKeepAliveTimer;

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
                lastAudioTime = Date.now();

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
                    // Calculate exact gap since last injection (when mute was detected) for smooth transition
                    const returnGap = Date.now() - lastInjectionTime;

                    // Use denomination method to fill exact gap before transitioning to real video
                    const denominationOrder = [320, 160, 80, 40, 32, 16, 8, 4, 2, 1]; // Largest to smallest available denominations
                    const denominationsToUse = [];

                    let remainingGap = returnGap;
                    for (const denom of denominationOrder) {
                      if (remainingGap >= denom) {
                        const count = Math.floor(remainingGap / denom);
                        denominationsToUse.push({ denom, count });
                        remainingGap %= denom;
                      }
                    }

                    // Inject the calculated denomination combination
                    let totalInjected = 0;
                    for (const { denom, count } of denominationsToUse) {
                      for (let i = 0; i < count && videoStream.writable; i++) {
                        if (denominationBuffers[denom]) {
                          videoStream.write(denominationBuffers[denom]);
                          totalInjected++;
                        }
                      }
                    }

                    // Update last injection time after return fill
                    lastInjectionTime = Date.now();

                    console.log(`🎥 Video return: Filled ${returnGap}ms gap with ${totalInjected} denomination frames`);
                    if (denominationsToUse.length > 0) {
                      const composition = denominationsToUse.map(d => `${d.count}×${d.denom}ms`).join(' + ');
                      console.log(`🎥 Return composition: ${composition} = ${denominationsToUse.reduce((sum, d) => sum + d.denom * d.count, 0)}ms`);
                    }

                    videoMuteState = "active";
                    console.log('🎥 Video returned: Resetting mute detection state to active');
                }

                // Write real video data directly
                if (conn?.streams?.videoStream?.writable) {
                    conn.streams.videoStream.write(buffer);
                    //console.log(`🎥 Real video: ${buffer.length} bytes written to FFmpeg`);
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
    conn._suppressNextSignalingCloseReconnect = conn.signaling || null;
    clearSignalingTimers(conn);
    releaseSignalingConnectLock(conn, conn._signalingConnectSocket);

    if (conn.media) {
        conn.media.removeAllListeners('error');
        conn.media.close();
    }
    if (conn.signaling) {
        conn.signaling.close();
    }

    if (conn.audioKeepAliveTimer) {
        clearInterval(conn.audioKeepAliveTimer);
    }
    if (conn.videoMuteDetectionTimer) {
        clearInterval(conn.videoMuteDetectionTimer);
    }
    if (conn.videoKeepAliveTimer) {
        clearInterval(conn.videoKeepAliveTimer);
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
