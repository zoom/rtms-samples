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

// Map to keep track of active WebSocket connections and audio chunks
const activeConnections = new Map();

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
        // Initiate connection to the signaling WebSocket server
        connectToSignalingWebSocket(meeting_uuid, rtms_stream_id, server_urls);
    }

    // Handle RTMS stopped event
    if (event === 'meeting.rtms_stopped') {
        console.log('RTMS Stopped event received');
        const { meeting_uuid } = payload;
        stopMeetingStreaming(meeting_uuid);
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

// Function to connect to the signaling WebSocket server
function connectToSignalingWebSocket(meetingUuid, streamId, serverUrl) {
    console.log(`Connecting to signaling WebSocket for meeting ${meetingUuid}`);

    const ws = new WebSocket(serverUrl);

    // Store connection for cleanup later
    if (!activeConnections.has(meetingUuid)) {
        activeConnections.set(meetingUuid, {});
    }
    activeConnections.get(meetingUuid).signaling = ws;

    ws.on('open', () => {
        console.log(`Signaling WebSocket connection opened for meeting ${meetingUuid}`);
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
        ws.send(JSON.stringify(handshake));
        console.log('Sent handshake to signaling server');
    });

    ws.on('message', (data) => {
        const msg = JSON.parse(data);
        console.log('Signaling Message:', JSON.stringify(msg, null, 2));

        // Handle successful handshake response
        if (msg.msg_type === 2 && msg.status_code === 0) { // SIGNALING_HAND_SHAKE_RESP
            const mediaUrl = msg.media_server?.server_urls?.all;
            if (mediaUrl) {
                // Connect to the media WebSocket server using the media URL
                connectToMediaWebSocket(mediaUrl, meetingUuid, streamId, ws);
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
        console.error('Signaling socket error:', err);
    });

    ws.on('close', () => {
        console.log('Signaling socket closed');
        if (activeConnections.has(meetingUuid)) {
            delete activeConnections.get(meetingUuid).signaling;
        }
    });
}

function connectToMediaWebSocket(mediaUrl, meetingUuid, streamId, signalingSocket) {
    console.log(`Connecting to media WebSocket at ${mediaUrl}`);

    // Start YouTube streaming
    const { videoStream, audioStream, ffmpeg } = startYouTubeStream();

    // Store streams in activeConnections map
    activeConnections.get(meetingUuid).streams = { videoStream, audioStream };
    activeConnections.get(meetingUuid).ffmpegProcess = ffmpeg;

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
            // Check if connection still exists (meeting active)
            if (!activeConnections.has(meetingUuid)) return;

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

        // Store timers for cleanup (needs to be updated when timers start)
        activeConnections.get(meetingUuid).audioKeepAliveTimer = audioKeepAliveTimer;
        activeConnections.get(meetingUuid).videoMuteDetectionTimer = videoMuteDetectionTimer;
        activeConnections.get(meetingUuid).videoKeepAliveTimer = videoKeepAliveTimer;
    };

    // Store all timers for cleanup
    activeConnections.get(meetingUuid).audioKeepAliveTimer = audioKeepAliveTimer;
    activeConnections.get(meetingUuid).videoMuteDetectionTimer = videoMuteDetectionTimer;
    activeConnections.get(meetingUuid).videoKeepAliveTimer = videoKeepAliveTimer;

    const mediaWs = new WebSocket(mediaUrl, { rejectUnauthorized: false });

    // Store connection for cleanup later
    activeConnections.get(meetingUuid).media = mediaWs;

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
            // Handle audio data - update timestamp and write immediately
            if (msg.msg_type === 14 && msg.content?.data) {
                const { data: audioData } = msg.content;
                const buffer = Buffer.from(audioData, 'base64');

                // Start keep-alive timers on first media (audio or video)
                startKeepAliveTimers();

                const conn = activeConnections.get(meetingUuid);

                // Update timestamp to reset keep-alive timer
                lastAudioTime = Date.now();

                // Write real audio data directly
                if (conn?.streams?.audioStream?.writable) {
                    conn.streams.audioStream.write(buffer);
                    //console.log(`🎵 Real audio: ${buffer.length} bytes written to FFmpeg`);
                }
            }

            // Handle video data - update timestamp and write immediately
            if (msg.msg_type === 15 && msg.content?.data) {
                const { data: videoData } = msg.content;
                const buffer = Buffer.from(videoData, 'base64');

                // Start keep-alive timers on first media (audio or video)
                startKeepAliveTimers();

                const conn = activeConnections.get(meetingUuid);

                // Update timestamp to reset keep-alive timer
                lastVideoTime = Date.now();

                // Reset video mute state when real video returns
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
        stopStreaming(meetingUuid);
    });

    function stopStreaming(meetingUuid) {
        const conn = activeConnections.get(meetingUuid);
        if (conn?.ffmpegProcess) {
            console.log('🛑 Stopping FFmpeg process');
            conn.ffmpegProcess.kill('SIGINT');
            activeConnections.delete(meetingUuid);
        }
    }
}

// Proper cleanup function for meeting streaming
function stopMeetingStreaming(meetingUuid) {
    const conn = activeConnections.get(meetingUuid);
    if (!conn) return;

    // Close WebSocket first to prevent pipe errors
    if (conn.media) {
        console.log('🛑 Closing media WebSocket first');
        conn.media.removeAllListeners('error'); // Ignore errors during shutdown
        conn.media.close();
        delete conn.media;
    }

    // Clear all timers
    if (conn.audioKeepAliveTimer) {
        clearInterval(conn.audioKeepAliveTimer);
        console.log('🛑 Cleared audio keep-alive timer');
    }
    if (conn.videoMuteDetectionTimer) {
        clearInterval(conn.videoMuteDetectionTimer);
        console.log('🛑 Cleared video mute detection timer');
    }
    if (conn.videoKeepAliveTimer) {
        clearInterval(conn.videoKeepAliveTimer);
        console.log('🛑 Cleared video keep-alive timer');
    }

    // Kill FFmpeg last (pipes will close cleanly)
    if (conn.ffmpegProcess) {
        console.log('🛑 Stopping FFmpeg process');
        conn.ffmpegProcess.kill('SIGINT');
    }

    // Remove from active connections
    activeConnections.delete(meetingUuid);
}

// Start the server and listen on the specified port
app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
    console.log(`Webhook endpoint available at http://localhost:${port}${WEBHOOK_PATH}`);
});
