import express from 'express';
import crypto from 'crypto';
import WebSocket from 'ws';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

const ZOOM_SECRET_TOKEN = process.env.ZOOM_SECRET_TOKEN;
const CLIENT_ID = process.env.ZM_CLIENT_ID;
const CLIENT_SECRET = process.env.ZM_CLIENT_SECRET;
const WEBHOOK_PATH = os.getenv("WEBHOOK_PATH", "/webhook")

app.use(express.json());

const activeConnections = new Map();

app.post(WEBHOOK_PATH, (req, res) => {
    const { event, payload } = req.body;
    console.log('Webhook received:', event);
    console.log('Payload:', JSON.stringify(payload, null, 2));

    if (event === 'endpoint.url_validation' && payload?.plainToken) {
        const hash = crypto.createHmac('sha256', ZOOM_SECRET_TOKEN)
            .update(payload.plainToken)
            .digest('hex');
        return res.json({
            plainToken: payload.plainToken,
            encryptedToken: hash,
        });
    }

    if (event === 'meeting.rtms_started') {
        const { meeting_uuid, rtms_stream_id, server_urls } = payload;
        console.log(`Starting RTMS for meeting ${meeting_uuid}`);
        connectToSignalingWebSocket(meeting_uuid, rtms_stream_id, server_urls);
    }

    if (event === 'meeting.rtms_stopped') {
        const { meeting_uuid } = payload;
        console.log(`Stopping RTMS for meeting ${meeting_uuid}`);
        if (activeConnections.has(meeting_uuid)) {
            const connections = activeConnections.get(meeting_uuid);
            for (const [type, connObj] of Object.entries(connections)) {
                const ws = connObj?.socket;
                if (ws && typeof ws.close === 'function') {
                    if (ws.readyState === WebSocket.CONNECTING) {
                        console.warn(`[${type}] socket is connecting, will close after open.`);
                        ws.once('open', () => ws.close());
                    } else {
                        ws.close();
                    }
                }
            }
            activeConnections.delete(meeting_uuid);
        }
    }

    res.sendStatus(200);
});

function generateSignature(meetingUuid, streamId) {
    const message = `${CLIENT_ID},${meetingUuid},${streamId}`;
    console.log('Generating signature for message:', message);
    return crypto.createHmac('sha256', CLIENT_SECRET).update(message).digest('hex');
}

function connectToSignalingWebSocket(meetingUuid, streamId, serverUrls) {
    console.log(`Connecting to signaling WebSocket for meeting ${meetingUuid}`);
    const signalingWs = new WebSocket(serverUrls);

    if (!activeConnections.has(meetingUuid)) {
        activeConnections.set(meetingUuid, {
            signaling: { socket: null, state: 'connecting', lastKeepAlive: null, url: serverUrls },
            media: { socket: null, state: 'idle', lastKeepAlive: null }
        });
    }

    const conn = activeConnections.get(meetingUuid);
    conn.signaling.socket = signalingWs;

    signalingWs.on('open', () => {
        // Stop here if RTMS already stopped
        if (!activeConnections.has(meetingUuid)) {
            console.warn(`Signaling WebSocket opened but RTMS was stopped for ${meetingUuid}, aborting.`);
            signalingWs.close();
            return;
        }

        console.log(`Signaling WebSocket opened for meeting ${meetingUuid}`);
        const signature = generateSignature(meetingUuid, streamId);
        const handshakeMsg = {
            msg_type: 1,
            meeting_uuid: meetingUuid,
            rtms_stream_id: streamId,
            signature
        };
        console.log('Sending signaling handshake:', handshakeMsg);
        signalingWs.send(JSON.stringify(handshakeMsg));
        conn.signaling.state = 'authenticated';
    });

    signalingWs.on('message', (data) => {
        const msg = JSON.parse(data);
        console.log('Received signaling message:', msg);
        if (msg.msg_type === 2 && msg.status_code === 0) {
            const mediaUrl = msg.media_server.server_urls.all;
            console.log('Signaling handshake successful. Media server URL:', mediaUrl);
            connectToMediaWebSocket(mediaUrl, meetingUuid, streamId, signalingWs);
            conn.signaling.state = 'ready';
        }
        if (msg.msg_type === 12) {
            conn.signaling.lastKeepAlive = Date.now();
            console.log('Responding to KEEP_ALIVE_REQ');
            signalingWs.send(JSON.stringify({
                msg_type: 13,
                timestamp: msg.timestamp
            }));
        }
    });

    signalingWs.on('close', () => {
        console.log(`Signaling WebSocket closed for meeting ${meetingUuid}`);
        const conn = activeConnections.get(meetingUuid);
        if (conn) conn.signaling.state = 'closed';
    });

    signalingWs.on('error', (err) => {
        const conn = activeConnections.get(meetingUuid);
        if (conn) conn.signaling.state = 'error';
        console.error('Signaling error:', err);
    });
}

function connectToMediaWebSocket(mediaUrl, meetingUuid, streamId, signalingSocket) {
    console.log(`Connecting to media WebSocket at ${mediaUrl} for meeting ${meetingUuid}`);
    const mediaWs = new WebSocket(mediaUrl);
    const conn = activeConnections.get(meetingUuid);
    conn.media.socket = mediaWs;
    conn.media.state = 'connecting';

    mediaWs.on('open', () => {
        // Stop here if RTMS already stopped
        if (!activeConnections.has(meetingUuid)) {
            console.warn(`Media WebSocket opened but RTMS was stopped for ${meetingUuid}, aborting handshake.`);
            mediaWs.close();
            return;
        }

        const signature = generateSignature(meetingUuid, streamId);
        const handshakeMsg = {
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
                    codec: 7,
                    resolution: 2,
                    fps: 25
                }
            }
        };
        console.log('Sending media handshake:', handshakeMsg);
        mediaWs.send(JSON.stringify(handshakeMsg));
        conn.media.state = 'authenticated';
    });

    mediaWs.on('message', (data) => {
        try {
            const msg = JSON.parse(data.toString());
            //console.log('Received media message:', msg);
            if (msg.msg_type === 4 && msg.status_code === 0) {
                console.log('Media handshake successful, sending CLIENT_READY_ACK');
                signalingSocket.send(JSON.stringify({
                    msg_type: 7,
                    rtms_stream_id: streamId
                }));
                conn.media.state = 'streaming';
            } else if (msg.msg_type === 12) {
                conn.media.lastKeepAlive = Date.now();
                console.log('Responding to KEEP_ALIVE_REQ');
                mediaWs.send(JSON.stringify({
                    msg_type: 13,
                    timestamp: msg.timestamp
                }));
            } else if (msg.msg_type === 14 && msg.content?.data) {
                const base64Data = msg.content.data.toString('base64');
                console.log('Base64 audio data:', base64Data);
            }
        } catch (err) {
            console.log('Raw audio data (hex):', data.toString('hex'));
        }
    });

    mediaWs.on('error', (err) => {
        console.error('Media socket error:', err);
        conn.media.state = 'error';
    });

    mediaWs.on('close', () => {
        console.log('Media socket closed for meeting', meetingUuid);
        if (!activeConnections.has(meetingUuid)) {
            console.warn(`RTMS already stopped for meeting ${meetingUuid}, skipping reconnection.`);
            return;
        }

        const conn = activeConnections.get(meetingUuid);
        if (conn.signaling.state === 'ready' && conn.signaling.socket?.readyState === WebSocket.OPEN) {
            console.log('Reconnecting media socket...');
            connectToMediaWebSocket(mediaUrl, meetingUuid, streamId, conn.signaling.socket);
        } else if (conn.signaling.url) {
            console.warn('Signaling socket not usable. Reconnecting both signaling and media...');
            connectToSignalingWebSocket(meetingUuid, streamId, conn.signaling.url);
        } else {
            console.warn('Cannot reconnect media: no signaling URL found.');
            conn.media.state = 'closed';
        }
    });
}

app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
});
