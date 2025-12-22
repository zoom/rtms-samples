import WebSocket from 'ws';
import { generateSignature, logRtmsStatusCode, logRtmsStopReason, logRtmsStreamState, logRtmsSessionState } from '../utils/rtms.js';
import { connectToMediaWebSocket } from './media.js';
import type { ActiveConnections } from '../types.js';

// Connect to signaling WebSocket
export function connectToSignalingWebSocket(
    sessionID: string,
    streamId: string,
    serverUrls: string,
    activeConnections: ActiveConnections,
    clientId: string,
    clientSecret: string
): void {
    console.log(`[Signaling] Starting connection function for video session ${sessionID}`);
    console.log(`[Signaling] Stream ID: ${streamId}, Server URL: ${serverUrls}`);
    console.log(`[Signaling] Connecting for video session ${sessionID}`);

    if (!serverUrls || typeof serverUrls !== 'string' || !serverUrls.startsWith('ws')) {
        console.error(`[Signaling] ❌ Invalid WebSocket URL:`, serverUrls);
        console.error(`[Signaling] URL validation failed - URL is null/undefined or doesn't start with ws/wss`);

        if (activeConnections.has(sessionID)) {
            console.error(`[Signaling] sessionID found in activeConnections map`);
            const conn = activeConnections.get(sessionID);
            if (conn) {
                conn.shouldReconnect = false;
                console.error(`[Signaling] sessionID found in activeConnections map. disabling reconnection`);
            }
        }
        else {
            console.error(`[Signaling] sessionID not found in activeConnections map`);
        }

        return;
    }

    let signalingWs: WebSocket;
    try {
        console.log(`[Signaling] Creating WebSocket instance for ${serverUrls}`);

        const wsOptions = {
            rejectUnauthorized: false
        };

        console.log(`Signaling WebSocket SSL verification disabled`);

        signalingWs = new WebSocket(serverUrls, [], wsOptions);
        console.log(`[Signaling] WebSocket instance created successfully, SSL verification disabled`);
    } catch (err: any) {
        console.error(`[Signaling] ❌ Failed to create WebSocket instance: ${err.message}`);
        return;
    }

    if (!activeConnections.has(sessionID)) {
        console.log(`[Signaling] Creating new connection entry for video session ${sessionID}`);
        activeConnections.set(sessionID, {
            sessionID,
            streamId,
            serverUrls,
            shouldReconnect: true,
            signaling: { socket: null, state: 'connecting', lastKeepAlive: null },
            media: { socket: null, state: 'idle', lastKeepAlive: null },
        });
    } else {
        console.log(`[Signaling] Refreshing existing connection entry for video session ${sessionID}`);
    }

    const conn = activeConnections.get(sessionID)!;
    conn.signaling.socket = signalingWs;
    conn.signaling.state = 'connecting';
    console.log(`[Signaling] Connection state set to 'connecting' for ${sessionID}`);

    signalingWs.on('open', () => {
        try {
            console.log(`[Signaling] WebSocket opened successfully for ${sessionID}`);
            if (!conn.shouldReconnect) {
                console.warn(`[Signaling] Aborting open: RTMS stopped for ${sessionID}`);
                signalingWs.close();
                return;
            }

            console.log(`[Signaling] Generating signature for handshake`);
            const signature = generateSignature(sessionID, streamId, clientId, clientSecret);
            console.log(`[Signaling] Signature generated successfully`);

            const handshakeMsg = {
                msg_type: 1,
                meeting_uuid: sessionID, //Video SDK still using back this instead of session_id
                session_id: sessionID, //Video SDK should use this for consistency
                rtms_stream_id: streamId,
                signature,
            };

            console.log(`[Signaling] Sending handshake for ${sessionID}`);
            console.log(`[Signaling] Handshake payload:`, JSON.stringify(handshakeMsg, null, 2));
            signalingWs.send(JSON.stringify(handshakeMsg));
            conn.signaling.state = 'authenticated';
            console.log(`[Signaling] Connection state updated to 'authenticated' for ${sessionID}`);
        } catch (err: any) {
            console.error(`[Signaling] Error in WebSocket open handler for ${sessionID}: ${err.message}`);
            console.error(`[Signaling] Open handler error details:`, err);
            conn.signaling.state = 'error';
            signalingWs.close();
        }
    });

    signalingWs.on('message', (data) => {
        console.log(`[Signaling] Received message for ${sessionID}`);
        let msg: any;
        try {
            msg = JSON.parse(data.toString());
            console.log(`[Signaling] Parsed message type: ${msg.msg_type}`);
        } catch {
            console.warn(`[Signaling] Invalid JSON message:`, data.toString());
            return;
        }

        switch (msg.msg_type) {

            case 2: // SIGNALING_HAND_SHAKE_RESP
                console.log(`[Signaling] Processing handshake response (case 2) for ${sessionID}`);
                console.log(`[Signaling] Handshake response:`, JSON.stringify(msg, null, 2));
                if (msg.status_code === 0) {
                    //This only return audio?
                    //const mediaUrl = msg.media_server?.server_urls?.all;
                    const mediaUrl = msg.media_server?.server_urls?.audio;
                    console.log(`[Signaling] Handshake OK. Media URL: ${mediaUrl}`);
                    conn.signaling.state = 'ready';
                    console.log(`[Signaling] Connection state updated to 'ready' for ${sessionID}`);

                    console.log(`[Signaling] Initiating media WebSocket connection`);
                    connectToMediaWebSocket(
                        mediaUrl,
                        sessionID,
                        streamId,
                        signalingWs,
                        conn,
                        clientId,
                        clientSecret,
                        activeConnections
                    );

                    const subscribePayload = {
                        msg_type: 5,
                        events: [
                            { event_type: 2, subscribe: true }, // ACTIVE_SPEAKER_CHANGE
                            { event_type: 3, subscribe: true }, // PARTICIPANT_JOIN
                            { event_type: 4, subscribe: true }  // PARTICIPANT_LEAVE
                        ]
                    };

                    console.log(`[Signaling] Sending event subscription payload`);
                    signalingWs.send(JSON.stringify(subscribePayload));
                    console.log(`[Signaling] Event subscription payload sent successfully`);

                } else {
                    console.warn(`[Signaling] Handshake failed: status_code = ${msg.status_code}`);
                    logRtmsStatusCode(msg.status_code);
                    logRtmsStopReason(msg.reason);
                }
                break;

            case 6: // first timestamp from signaling server
                console.log(`[Signaling] Processing event message (case 6) for ${sessionID}`);
                console.log(`[Signaling] Event message:`, JSON.stringify(msg, null, 2));
                if (msg.event) {
                    console.log(`[Signaling] Event type: ${msg.event.event_type}`);
                    switch (msg.event.event_type) {
                        case 0: // UNDEFINED
                            console.log(`[Event] UNDEFINED event received`);
                            break;

                        case 1: // FIRST_PACKET_TIMESTAMP
                            console.log(`[Event] FIRST_PACKET_TIMESTAMP — first media packet at ${msg.event.timestamp}`);
                            break;

                        case 2: // ACTIVE_SPEAKER_CHANGE
                            console.log(`[Event] ACTIVE_SPEAKER_CHANGE — ${msg.event.user_name} (ID: ${msg.event.user_id}) is now speaking`);
                            break;

                        case 3: // PARTICIPANT_JOIN
                            console.log(`[Event] PARTICIPANT_JOIN — ${msg.event.user_name} (ID: ${msg.event.user_id}) joined`);
                            break;

                        case 4: // PARTICIPANT_LEAVE
                            console.log(`[Event] PARTICIPANT_LEAVE — ${msg.event.user_name} (ID: ${msg.event.user_id}) left`);
                            break;

                        default:
                            console.log(`[Event] Unknown event_type: ${msg.event.event_type}`);
                    }
                } else {
                    console.log(`[Signaling] Event message received but no event data`);
                }

                break;

            case 8: // Stream State changed
                console.log(`[Signaling] Processing stream state change (case 8) for ${sessionID}`);
                console.log(`[Signaling] Stream state message:`, JSON.stringify(msg, null, 2));

                if ('reason' in msg) {
                    console.log(`[Signaling] Stream state change reason: ${msg.reason}`);
                    logRtmsStopReason(msg.reason);
                }

                if ('state' in msg) {
                    console.log(`[Signaling] Stream state: ${msg.state}`);
                    logRtmsStreamState(msg.state);
                }
                if (msg.reason === 6 && msg.state === 4) {
                    console.log(`[Signaling] Video session ended, cleaning up connections for ${sessionID}`);

                    if (conn) {
                        conn.shouldReconnect = false;
                        console.log(`[Signaling] Disabled reconnection for ${sessionID}`);

                        if (conn.signaling) {
                            conn.signaling.state = 'closed';
                            const ws = conn.signaling.socket;
                            if (ws && typeof ws.close === 'function') {
                                console.log(`[Signaling] Closing signaling WebSocket for ${sessionID}`);
                                if (ws.readyState === WebSocket.CONNECTING) {
                                    ws.once('open', () => ws.close());
                                } else {
                                    ws.close();
                                }
                            }
                        }

                        if (conn.media) {
                            conn.media.state = 'closed';
                            const ws = conn.media.socket;
                            if (ws && typeof ws.close === 'function') {
                                console.log(`[Signaling] Closing media WebSocket for ${sessionID}`);
                                if (ws.readyState === WebSocket.CONNECTING) {
                                    ws.once('open', () => ws.close());
                                } else {
                                    ws.close();
                                }
                            }
                        }

                        activeConnections.delete(sessionID);
                    }

                }

                break;
            case 9: // Session State Changed
                console.log(`[Signaling] Processing session state change (case 9) for ${sessionID}`);
                console.log(`[Signaling] Session state message:`, JSON.stringify(msg, null, 2));
                if ('stop_reason' in msg) {
                    console.log(`[Signaling] Session stop reason: ${msg.stop_reason}`);
                    logRtmsStopReason(msg.reason);
                }

                if ('state' in msg) {
                    console.log(`[Signaling] Session state: ${msg.state}`);
                    logRtmsSessionState(msg.state);
                }

                break;
            case 12: // KEEP_ALIVE_REQ
                console.log(`[Signaling] Processing keep-alive request (case 12) for ${sessionID}`);
                console.log(`[Signaling] Keep-alive timestamp: ${msg.timestamp}`);
                conn.signaling.lastKeepAlive = Date.now();
                console.log(`[Signaling] Updated last keep-alive time for ${sessionID}`);
                const keepAliveResponse = {
                    msg_type: 13,
                    timestamp: msg.timestamp
                };
                console.log(`[Signaling] Sending keep-alive response:`, JSON.stringify(keepAliveResponse, null, 2));
                signalingWs.send(JSON.stringify(keepAliveResponse));
                console.log(`[Signaling] Keep-alive response sent for ${sessionID}`);
                break;

            default:
                console.log(`[Signaling] Unhandled msg_type: ${msg.msg_type}`);
                break;
        }
    });

    signalingWs.on('close', (code, reason) => {
        console.log(`[Signaling] WebSocket closed for ${sessionID}, code: ${code}, reason: ${reason}`);

        const conn = activeConnections.get(sessionID);
        if (conn) {
            conn.signaling.state = 'closed';
            console.log(`[Signaling] Connection state updated to 'closed' for ${sessionID}`);

            if (conn.shouldReconnect) {
                console.log(`[Signaling] Will reconnect for ${sessionID} in 3s...`);
                setTimeout(() => {
                    if (conn.shouldReconnect) {
                        console.log(`[Signaling] Starting reconnection for ${sessionID}`);
                        connectToSignalingWebSocket(
                            sessionID,
                            streamId,
                            conn.serverUrls,
                            activeConnections,
                            clientId,
                            clientSecret
                        );
                    } else {
                        console.log(`[Signaling] Reconnection cancelled for ${sessionID}`);
                    }
                }, 3000);
            } else {
                console.log(`[Signaling] Not reconnecting — RTMS was stopped for ${sessionID}.`);
            }
        } else {
            console.log(`[Signaling] No connection entry found for ${sessionID} during close`);
        }
    });

    signalingWs.on('error', (err) => {
        console.error(`[Signaling] WebSocket error for ${sessionID}: ${err.message}`);
        console.error(`[Signaling] Error details:`, err);
        if (conn) {
            conn.signaling.state = 'error';
            console.log(`[Signaling] Connection state updated to 'error' for ${sessionID}`);
        }
    });
}

