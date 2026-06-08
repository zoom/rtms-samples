/**
 * RTMS Reconnection & Chaos Mode Sample
 *
 * This sample demonstrates how to handle all three RTMS reconnection scenarios
 * using raw WebSockets (no RTMSManager library). It also includes a "chaos mode"
 * that deliberately suppresses keep-alive responses to induce server disconnection,
 * letting you observe the full reconnection flow in action.
 *
 * Reconnection Scenarios (from Zoom RTMS docs):
 *   1. RTMS Server Failure  — New meeting.rtms_started webhook arrives
 *   2. Signal Connection Down — meeting.rtms_interrupted webhook arrives
 *   3. Media Connection Down  — MEDIA_CONNECTION_INTERRUPTED event via signaling
 *
 * Docs: https://developers.zoom.us/docs/rtms/meetings/work-with-streams/#failover-and-reconnection
 */

import express from 'express';
import WebSocket from 'ws';
import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config();


// ============================================================================
//  SECTION 1: CONFIGURATION
// ============================================================================

const PORT = process.env.PORT || 3000;
const WEBHOOK_PATH = process.env.WEBHOOK_PATH || '/webhook';

// Zoom app credentials (from https://marketplace.zoom.us/)
const ZOOM_CLIENT_ID = process.env.ZOOM_CLIENT_ID;
const ZOOM_CLIENT_SECRET = process.env.ZOOM_CLIENT_SECRET;
const ZOOM_SECRET_TOKEN = process.env.ZOOM_SECRET_TOKEN;

// Chaos Mode: suppress keep-alive responses to trigger server disconnection.
//
// When the RTMS server sends a keep-alive ping (msg_type 12), our app is
// expected to respond (msg_type 13). If we miss 3 consecutive pings (~30s),
// the server terminates our connection:
//   - Signaling miss → server interrupts BOTH sockets, sends meeting.rtms_interrupted webhook
//   - Media miss     → server interrupts ONLY media, sends MEDIA_CONNECTION_INTERRUPTED via signaling
//
// Set these to "true" to observe each scenario.
const CHAOS_SUPPRESS_SIGNALING_KEEPALIVE = process.env.CHAOS_SUPPRESS_SIGNALING_KEEPALIVE === 'true';
const CHAOS_SUPPRESS_MEDIA_KEEPALIVE = process.env.CHAOS_SUPPRESS_MEDIA_KEEPALIVE === 'true';

// Chaos Mode: force-disconnect a socket after N seconds.
//
// The keep-alive suppression above only works during silence (keep-alives are
// sent "every 10 seconds when no data is flowing"). When transcripts or audio
// are actively streaming, the server doesn't send keep-alive pings at all.
//
// To reliably induce a disconnection while data is flowing, set one of these
// to a number of seconds. The app will forcibly close the socket after that
// delay, simulating a network failure.
//
//   CHAOS_FORCE_DISCONNECT_SIGNALING_AFTER_SEC=15
//     → Forcibly closes the signaling socket 15s after it opens
//     → Server detects the drop and sends meeting.rtms_interrupted → Scenario 2
//
//   CHAOS_FORCE_DISCONNECT_MEDIA_AFTER_SEC=15
//     → Forcibly closes the media socket 15s after it opens
//     → Server detects the drop and sends MEDIA_CONNECTION_INTERRUPTED → Scenario 3
//
const CHAOS_FORCE_DISCONNECT_SIGNALING_AFTER_SEC = parseInt(process.env.CHAOS_FORCE_DISCONNECT_SIGNALING_AFTER_SEC) || 0;
const CHAOS_FORCE_DISCONNECT_MEDIA_AFTER_SEC = parseInt(process.env.CHAOS_FORCE_DISCONNECT_MEDIA_AFTER_SEC) || 0;

// Reconnection backoff: starts at 3s, doubles each attempt, caps at 30s.
const RECONNECT_BASE_DELAY_MS = 3000;
const RECONNECT_MAX_DELAY_MS = 30000;
const RECONNECT_BACKOFF_FACTOR = 2;


// ============================================================================
//  SECTION 2: RTMS PROTOCOL CONSTANTS
//  See: https://developers.zoom.us/docs/rtms/data-types/
// ============================================================================

// Message types used in signaling and media WebSocket communication.
const MSG_TYPE = {
  SIGNALING_HANDSHAKE_REQ:  1,   // App → Signaling: initiate handshake
  SIGNALING_HANDSHAKE_RESP: 2,   // Signaling → App: handshake result + media URLs
  MEDIA_HANDSHAKE_REQ:      3,   // App → Media: initiate media handshake
  MEDIA_HANDSHAKE_RESP:     4,   // Media → App: handshake result + confirmed params
  EVENT_UPDATE:             6,   // Signaling → App: in-meeting event notification
  CLIENT_READY_ACK:         7,   // App → Signaling: ready to receive media data
  STREAM_STATE_UPDATE:      8,   // Signaling → App: stream state changed
  SESSION_STATE_UPDATE:     9,   // Signaling → App: session state changed
  KEEP_ALIVE_REQ:           12,  // Server → App: are you still there?
  KEEP_ALIVE_RESP:          13,  // App → Server: yes, still here
  MEDIA_DATA_TRANSCRIPT:    17,  // Media → App: transcript text
};

// Event types delivered inside EVENT_UPDATE (msg_type 6) messages.
const EVENT_TYPE = {
  ACTIVE_SPEAKER_CHANGE:        2,
  PARTICIPANT_JOIN:              3,
  PARTICIPANT_LEAVE:             4,
  MEDIA_CONNECTION_INTERRUPTED:  7,  // A media connection was interrupted
};

// Stream state values in STREAM_STATE_UPDATE (msg_type 8) messages.
const STREAM_STATE = {
  INACTIVE:    0,
  ACTIVE:      1,
  INTERRUPTED: 2,  // Signal or data connection has a problem
  TERMINATING: 3,
  TERMINATED:  4,
};

// Reason codes explaining why a stream state changed.
const STOP_REASON = {
  MEETING_ENDED:                    6,
  SIGNAL_CONNECTION_INTERRUPTED:    13,
  DATA_CONNECTION_INTERRUPTED:      14,
  SIGNAL_CONNECTION_CLOSED:         15,
  DATA_CONNECTION_CLOSED:           16,
};


// ============================================================================
//  SECTION 3: CONNECTION STATE MANAGEMENT
// ============================================================================

// Tracks all active RTMS stream connections, keyed by rtms_stream_id.
// Each entry holds the WebSocket handles, reconnection state, and diagnostics.
const activeStreams = new Map();

/**
 * Creates a new connection state object for a stream.
 * This is the central data structure — everything about a stream's lifecycle
 * lives here so reconnection handlers can access it.
 */
function createStreamConnection(meetingUuid, streamId, serverUrls) {
  return {
    meetingUuid,
    streamId,
    serverUrls,           // Signaling server URL (from the webhook)
    signalingWs: null,     // WebSocket handle for signaling connection
    mediaWs: null,         // WebSocket handle for media connection
    mediaUrl: null,        // Media server URL (from signaling handshake response)
    state: 'CONNECTING',   // CONNECTING | STREAMING | RECONNECTING | STOPPED
    reconnectAttempts: 0,  // Consecutive failed reconnection attempts (for backoff)

    // Chaos mode diagnostics: track how many keep-alives we've seen vs suppressed
    signalingKeepAliveCount: 0,
    signalingKeepAliveSuppressed: 0,
    mediaKeepAliveCount: 0,
    mediaKeepAliveSuppressed: 0,

    // Count transcripts received (useful to verify reconnection worked)
    transcriptCount: 0,
  };
}


// ============================================================================
//  SECTION 4: UTILITY FUNCTIONS
// ============================================================================

/**
 * Generate HMAC-SHA256 signature for RTMS authentication.
 * Format: HMACSHA256("client_id,meeting_uuid,rtms_stream_id", client_secret)
 * See: https://developers.zoom.us/docs/rtms/meetings/work-with-streams/#step-3-app-establishes-signaling-connection
 */
function generateSignature(meetingUuid, streamId) {
  const message = `${ZOOM_CLIENT_ID},${meetingUuid},${streamId}`;
  return crypto.createHmac('sha256', ZOOM_CLIENT_SECRET).update(message).digest('hex');
}

/**
 * Calculate reconnection delay with exponential backoff.
 * Attempt 0: 3s, Attempt 1: 6s, Attempt 2: 12s, Attempt 3: 24s, then capped at 30s.
 */
function getReconnectDelay(attempts) {
  return Math.min(
    RECONNECT_BASE_DELAY_MS * Math.pow(RECONNECT_BACKOFF_FACTOR, attempts),
    RECONNECT_MAX_DELAY_MS
  );
}

/**
 * Structured logger. Prefixes each line with timestamp, section tag, and
 * the last 8 characters of the stream ID for easy correlation.
 */
function log(streamId, section, message) {
  const ts = new Date().toISOString();
  const shortId = streamId ? streamId.slice(-8) : '--------';
  console.log(`[${ts}] [${section.padEnd(10)}] [${shortId}] ${message}`);
}

/**
 * Safely close a WebSocket without throwing errors.
 */
function safeCloseWs(ws) {
  if (!ws) return;
  try {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close();
    }
  } catch (_) {
    // Ignore close errors — the socket may already be gone
  }
}


// ============================================================================
//  SECTION 5: SIGNALING WEBSOCKET
//  The signaling connection is the control channel. It delivers:
//    - Handshake responses with media server URLs
//    - Keep-alive pings
//    - Event notifications (participant changes, media interruptions)
//    - Stream and session state updates
//  See: https://developers.zoom.us/docs/rtms/event-reference/
// ============================================================================

function connectToSignalingWebSocket(conn) {
  // Guard: don't reconnect if the stream has been intentionally stopped
  if (conn.state === 'STOPPED') {
    log(conn.streamId, 'SIGNALING', 'Stream is stopped — aborting connection attempt.');
    return;
  }

  log(conn.streamId, 'SIGNALING', `Connecting to signaling server: ${conn.serverUrls}`);
  const ws = new WebSocket(conn.serverUrls);
  conn.signalingWs = ws;

  // --- Connection opened: send the signaling handshake ---
  ws.on('open', () => {
    log(conn.streamId, 'SIGNALING', 'WebSocket opened. Sending handshake (msg_type: 1)...');

    ws.send(JSON.stringify({
      msg_type:         MSG_TYPE.SIGNALING_HANDSHAKE_REQ,
      protocol_version: 1,
      meeting_uuid:     conn.meetingUuid,
      rtms_stream_id:   conn.streamId,
      sequence:         Math.floor(Math.random() * 1e9),
      signature:        generateSignature(conn.meetingUuid, conn.streamId),
      buffer_data:      false,
    }));

    // CHAOS MODE: Force-disconnect the signaling socket after a delay.
    // This works even when data is actively flowing (unlike keep-alive suppression).
    if (CHAOS_FORCE_DISCONNECT_SIGNALING_AFTER_SEC > 0) {
      const delaySec = CHAOS_FORCE_DISCONNECT_SIGNALING_AFTER_SEC;
      log(conn.streamId, 'CHAOS', `Will FORCE-CLOSE signaling socket in ${delaySec}s...`);
      setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) {
          log(conn.streamId, 'CHAOS', `Force-closing signaling socket NOW (after ${delaySec}s).`);
          log(conn.streamId, 'CHAOS', 'This simulates a network failure. Expect meeting.rtms_interrupted webhook → Scenario 2.');
          ws.terminate(); // terminate() is an abrupt close (no close frame), simulating a crash
        }
      }, delaySec * 1000);
    }
  });

  // --- Handle all incoming signaling messages ---
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    handleSignalingMessage(conn, msg);
  });

  // --- Signaling socket closed ---
  // NOTE: We do NOT auto-reconnect on close. Reconnection is event-driven:
  //   - If the server went down, we'll get a new meeting.rtms_started webhook (Scenario 1)
  //   - If our signal dropped, we'll get a meeting.rtms_interrupted webhook (Scenario 2)
  // Auto-reconnecting on close would risk duplicate connections.
  ws.on('close', (code) => {
    log(conn.streamId, 'SIGNALING', `WebSocket closed (code: ${code}).`);
    conn.signalingWs = null;
  });

  ws.on('error', (err) => {
    log(conn.streamId, 'SIGNALING', `WebSocket error: ${err.message}`);
  });
}

/**
 * Route incoming signaling messages to the appropriate handler.
 */
function handleSignalingMessage(conn, msg) {
  switch (msg.msg_type) {

    // ---------------------------------------------------------------
    // Signaling Handshake Response (msg_type 2)
    // Contains the media server URLs we need to connect to.
    // ---------------------------------------------------------------
    case MSG_TYPE.SIGNALING_HANDSHAKE_RESP:
      if (msg.status_code === 0) {
        // Success — extract the transcript media URL (or the "all" URL as fallback)
        const mediaUrl = msg.media_server?.server_urls?.transcript
                      || msg.media_server?.server_urls?.all;
        conn.mediaUrl = mediaUrl;
        conn.reconnectAttempts = 0; // Reset backoff on successful handshake
        log(conn.streamId, 'SIGNALING', `Handshake successful. Media server URL: ${mediaUrl}`);

        // Proceed to establish the media connection
        connectToMediaWebSocket(conn);
      } else {
        log(conn.streamId, 'SIGNALING', `Handshake FAILED — status_code: ${msg.status_code}, reason: ${msg.reason || 'none'}`);
      }
      break;

    // ---------------------------------------------------------------
    // Keep-Alive Request (msg_type 12)
    // Server pings us every ~10 seconds. We must respond to stay connected.
    // If we miss 3 consecutive pings, the server terminates the connection.
    // See: https://developers.zoom.us/docs/rtms/event-reference/#keep-alive-request
    // ---------------------------------------------------------------
    case MSG_TYPE.KEEP_ALIVE_REQ:
      conn.signalingKeepAliveCount++;

      if (CHAOS_SUPPRESS_SIGNALING_KEEPALIVE) {
        // CHAOS MODE: deliberately skip the response to trigger disconnection.
        // After 3 missed pings (~30s), the server will:
        //   1. Terminate both signaling and media connections
        //   2. Send a meeting.rtms_interrupted webhook
        conn.signalingKeepAliveSuppressed++;
        log(conn.streamId, 'CHAOS', `Suppressing signaling keep-alive #${conn.signalingKeepAliveCount} (${conn.signalingKeepAliveSuppressed} suppressed so far)`);
        if (conn.signalingKeepAliveSuppressed <= 3) {
          log(conn.streamId, 'CHAOS', `Server will terminate after 3 missed pings. Current: ${conn.signalingKeepAliveSuppressed}/3`);
        }
      } else {
        // Normal: respond to keep the connection alive
        conn.signalingWs.send(JSON.stringify({
          msg_type:  MSG_TYPE.KEEP_ALIVE_RESP,
          timestamp: msg.timestamp,
        }));
      }
      break;

    // ---------------------------------------------------------------
    // Event Update (msg_type 6)
    // In-meeting event notifications delivered through the signaling channel.
    // We're specifically watching for MEDIA_CONNECTION_INTERRUPTED (event_type 7).
    // See: https://developers.zoom.us/docs/rtms/event-reference/
    // ---------------------------------------------------------------
    case MSG_TYPE.EVENT_UPDATE:
      handleEventUpdate(conn, msg);
      break;

    // ---------------------------------------------------------------
    // Stream State Update (msg_type 8)
    // Tells us when the stream becomes active, interrupted, or terminated.
    // See: https://developers.zoom.us/docs/rtms/event-reference/#stream-state-updated
    // ---------------------------------------------------------------
    case MSG_TYPE.STREAM_STATE_UPDATE:
      handleStreamStateUpdate(conn, msg);
      break;

    // ---------------------------------------------------------------
    // Session State Update (msg_type 9)
    // Individual participant session changes (started, paused, resumed, stopped).
    // See: https://developers.zoom.us/docs/rtms/event-reference/#session-state-updated
    // ---------------------------------------------------------------
    case MSG_TYPE.SESSION_STATE_UPDATE:
      log(conn.streamId, 'SESSION', `Session state: ${msg.state}, session_id: ${msg.rtms_session_id || 'n/a'}, reason: ${msg.stop_reason || msg.reason || 'n/a'}`);
      break;

    default:
      log(conn.streamId, 'SIGNALING', `Received msg_type: ${msg.msg_type} (unhandled in this sample)`);
  }
}

/**
 * Handle EVENT_UPDATE messages (msg_type 6).
 * These carry in-meeting events like speaker changes and, critically,
 * MEDIA_CONNECTION_INTERRUPTED notifications.
 */
function handleEventUpdate(conn, msg) {
  const eventType = msg.event?.event_type;

  switch (eventType) {

    // ---------------------------------------------------------------
    // RECONNECTION SCENARIO 3: Media Connection Interrupted
    //
    // The signaling connection is still alive, but a media socket went down.
    // The server notifies us through the signaling channel.
    //
    // Action: Reconnect ONLY the media WebSocket. Signaling stays up.
    // See: Failover and reconnection > App issue (data socket only)
    // ---------------------------------------------------------------
    case EVENT_TYPE.MEDIA_CONNECTION_INTERRUPTED:
      log(conn.streamId, 'RECONNECT', '========================================');
      log(conn.streamId, 'RECONNECT', 'SCENARIO 3: MEDIA_CONNECTION_INTERRUPTED');
      log(conn.streamId, 'RECONNECT', 'Signaling is still alive. Reconnecting ONLY the media socket.');
      log(conn.streamId, 'RECONNECT', 'Server allows ~30 seconds for media reconnection.');
      log(conn.streamId, 'RECONNECT', '========================================');
      handleMediaOnlyReconnect(conn);
      break;

    case EVENT_TYPE.ACTIVE_SPEAKER_CHANGE:
      log(conn.streamId, 'EVENT', `Active speaker: ${msg.event?.user_name || 'unknown'} (user_id: ${msg.event?.user_id})`);
      break;

    case EVENT_TYPE.PARTICIPANT_JOIN:
      log(conn.streamId, 'EVENT', `Participant(s) joined: ${JSON.stringify(msg.event?.participants)}`);
      break;

    case EVENT_TYPE.PARTICIPANT_LEAVE:
      log(conn.streamId, 'EVENT', `Participant(s) left: ${JSON.stringify(msg.event?.participants)}`);
      break;

    default:
      log(conn.streamId, 'EVENT', `event_type: ${eventType}`);
  }
}

/**
 * Handle STREAM_STATE_UPDATE messages (msg_type 8).
 * The stream state tells us if the overall RTMS stream is active, interrupted,
 * or being terminated.
 */
function handleStreamStateUpdate(conn, msg) {
  log(conn.streamId, 'STREAM', `Stream state: ${msg.state}, reason: ${msg.reason || 'n/a'}`);

  switch (msg.state) {

    case STREAM_STATE.ACTIVE:
      log(conn.streamId, 'STREAM', 'Stream is ACTIVE. Media data is flowing.');
      break;

    case STREAM_STATE.INTERRUPTED:
      // The stream is interrupted. The reason code tells us which connection broke.
      if (msg.reason === STOP_REASON.DATA_CONNECTION_INTERRUPTED) {
        log(conn.streamId, 'RECONNECT', 'STREAM_STATE_UPDATE indicates data/media connection interrupted.');
        // This is another path to Scenario 3. The EVENT_UPDATE (msg_type 6) with
        // MEDIA_CONNECTION_INTERRUPTED may also arrive. Guard against double-reconnect
        // by checking if we're already reconnecting.
        if (conn.state !== 'RECONNECTING') {
          handleMediaOnlyReconnect(conn);
        }
      } else if (msg.reason === STOP_REASON.SIGNAL_CONNECTION_INTERRUPTED) {
        // Signaling interrupted — but if we're receiving this message, the signaling
        // socket is actually still delivering messages. The meeting.rtms_interrupted
        // webhook will be the primary trigger for Scenario 2.
        log(conn.streamId, 'STREAM', 'Signal connection interrupted. Waiting for meeting.rtms_interrupted webhook...');
      } else {
        log(conn.streamId, 'STREAM', `Stream interrupted with reason: ${msg.reason}. Monitoring for reconnection triggers.`);
      }
      break;

    case STREAM_STATE.TERMINATING:
      log(conn.streamId, 'STREAM', 'Stream is TERMINATING.');
      break;

    case STREAM_STATE.TERMINATED:
      log(conn.streamId, 'STREAM', 'Stream is TERMINATED. Cleaning up.');
      cleanupStream(conn.streamId);
      break;

    default:
      break;
  }
}


// ============================================================================
//  SECTION 6: MEDIA WEBSOCKET (TRANSCRIPT)
//  The media connection delivers the actual meeting data. In this sample we
//  request transcript only (media_type: 8) to keep things simple — transcript
//  data is text/JSON, easy to verify in console output.
//  See: https://developers.zoom.us/docs/rtms/event-reference/#media-handshake-request
// ============================================================================

function connectToMediaWebSocket(conn) {
  if (conn.state === 'STOPPED') {
    log(conn.streamId, 'MEDIA', 'Stream is stopped — aborting media connection attempt.');
    return;
  }
  if (!conn.mediaUrl) {
    log(conn.streamId, 'MEDIA', 'ERROR: No media URL available. Cannot connect to media server.');
    return;
  }

  log(conn.streamId, 'MEDIA', `Connecting to media server: ${conn.mediaUrl}`);
  const ws = new WebSocket(conn.mediaUrl);
  conn.mediaWs = ws;

  // --- Connection opened: send the media handshake ---
  ws.on('open', () => {
    log(conn.streamId, 'MEDIA', 'WebSocket opened. Sending media handshake (msg_type: 3)...');

    ws.send(JSON.stringify({
      msg_type:           MSG_TYPE.MEDIA_HANDSHAKE_REQ,
      protocol_version:   1,
      meeting_uuid:       conn.meetingUuid,
      rtms_stream_id:     conn.streamId,
      signature:          generateSignature(conn.meetingUuid, conn.streamId),
      media_type:         8,     // Transcript only (bitmask: TRANSCRIPT = 0x01 << 3 = 8)
      payload_encryption: false,
    }));

    // CHAOS MODE: Force-disconnect the media socket after a delay.
    // This works even when data is actively flowing (unlike keep-alive suppression).
    if (CHAOS_FORCE_DISCONNECT_MEDIA_AFTER_SEC > 0) {
      const delaySec = CHAOS_FORCE_DISCONNECT_MEDIA_AFTER_SEC;
      log(conn.streamId, 'CHAOS', `Will FORCE-CLOSE media socket in ${delaySec}s...`);
      setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) {
          log(conn.streamId, 'CHAOS', `Force-closing media socket NOW (after ${delaySec}s).`);
          log(conn.streamId, 'CHAOS', 'This simulates a network failure. Expect MEDIA_CONNECTION_INTERRUPTED → Scenario 3.');
          ws.terminate(); // terminate() is an abrupt close (no close frame), simulating a crash
        }
      }, delaySec * 1000);
    }
  });

  // --- Handle all incoming media messages ---
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      handleMediaMessage(conn, msg);
    } catch (err) {
      log(conn.streamId, 'MEDIA', `Error parsing message: ${err.message}`);
    }
  });

  // --- Media socket closed ---
  // Like signaling, we don't auto-reconnect on close. Reconnection is triggered
  // by the signaling channel (MEDIA_CONNECTION_INTERRUPTED) or by a webhook.
  ws.on('close', (code) => {
    log(conn.streamId, 'MEDIA', `WebSocket closed (code: ${code}).`);
    conn.mediaWs = null;
  });

  ws.on('error', (err) => {
    log(conn.streamId, 'MEDIA', `WebSocket error: ${err.message}`);
  });
}

/**
 * Route incoming media messages to the appropriate handler.
 */
function handleMediaMessage(conn, msg) {
  switch (msg.msg_type) {

    // ---------------------------------------------------------------
    // Media Handshake Response (msg_type 4)
    // Confirms the media connection is established and returns the
    // negotiated media parameters.
    // After this, we must send CLIENT_READY_ACK to the SIGNALING socket
    // to tell the server we're ready to receive data.
    // See: https://developers.zoom.us/docs/rtms/event-reference/#client-ready-ack-message
    // ---------------------------------------------------------------
    case MSG_TYPE.MEDIA_HANDSHAKE_RESP:
      if (msg.status_code === 0) {
        log(conn.streamId, 'MEDIA', 'Media handshake successful.');
        conn.state = 'STREAMING';
        conn.reconnectAttempts = 0; // Reset backoff on success

        // Send CLIENT_READY_ACK to the SIGNALING socket (not the media socket!)
        // This tells the server the full handshake is complete and we're ready for data.
        if (conn.signalingWs && conn.signalingWs.readyState === WebSocket.OPEN) {
          log(conn.streamId, 'MEDIA', 'Sending CLIENT_READY_ACK (msg_type: 7) to signaling server...');
          conn.signalingWs.send(JSON.stringify({
            msg_type:       MSG_TYPE.CLIENT_READY_ACK,
            rtms_stream_id: conn.streamId,
          }));
          log(conn.streamId, 'MEDIA', 'Ready to receive transcript data!');
        } else {
          log(conn.streamId, 'MEDIA', 'WARNING: Signaling socket not open — cannot send CLIENT_READY_ACK.');
        }
      } else {
        log(conn.streamId, 'MEDIA', `Media handshake FAILED — status_code: ${msg.status_code}, reason: ${msg.reason || 'none'}`);
      }
      break;

    // ---------------------------------------------------------------
    // Keep-Alive Request (msg_type 12)
    // Same mechanism as signaling — respond or get disconnected.
    // Missing 3 media keep-alives causes the server to terminate ONLY
    // the media connection (signaling stays alive).
    // ---------------------------------------------------------------
    case MSG_TYPE.KEEP_ALIVE_REQ:
      conn.mediaKeepAliveCount++;

      if (CHAOS_SUPPRESS_MEDIA_KEEPALIVE) {
        // CHAOS MODE: deliberately skip the response.
        // After 3 missed pings (~30s), the server will:
        //   1. Terminate the media connection
        //   2. Send MEDIA_CONNECTION_INTERRUPTED (event_type 7) through signaling
        conn.mediaKeepAliveSuppressed++;
        log(conn.streamId, 'CHAOS', `Suppressing media keep-alive #${conn.mediaKeepAliveCount} (${conn.mediaKeepAliveSuppressed} suppressed so far)`);
        if (conn.mediaKeepAliveSuppressed <= 3) {
          log(conn.streamId, 'CHAOS', `Server will terminate media after 3 missed pings. Current: ${conn.mediaKeepAliveSuppressed}/3`);
        }
      } else {
        conn.mediaWs.send(JSON.stringify({
          msg_type:  MSG_TYPE.KEEP_ALIVE_RESP,
          timestamp: msg.timestamp,
        }));
      }
      break;

    // ---------------------------------------------------------------
    // Transcript Data (msg_type 17)
    // The actual transcript text from meeting participants.
    // See: https://developers.zoom.us/docs/rtms/event-reference/#transcript-data
    // ---------------------------------------------------------------
    case MSG_TYPE.MEDIA_DATA_TRANSCRIPT:
      conn.transcriptCount++;
      if (msg.content?.data) {
        const userName = msg.content.user_name || 'Unknown';
        const text = msg.content.data;
        log(conn.streamId, 'TRANSCRIPT', `[${userName}]: ${text}`);
      }
      break;

    default:
      // Silently ignore other media message types (audio, video, etc.)
      break;
  }
}


// ============================================================================
//  SECTION 7: RECONNECTION HANDLERS
//  Three distinct scenarios, each with its own handler.
//  See: https://developers.zoom.us/docs/rtms/meetings/work-with-streams/#failover-and-reconnection
// ============================================================================

/**
 * SCENARIO 1: RTMS Server Failure
 *
 * What happened:
 *   The Zoom RTMS server went down. A new RTMS server has spun up and sent
 *   a fresh meeting.rtms_started webhook with (possibly new) server_urls.
 *
 * What to do:
 *   Tear down all existing connections and start fresh with the new URLs.
 *   The meeting_uuid and rtms_stream_id stay the same.
 *
 * Trigger:
 *   meeting.rtms_started webhook arrives for a streamId we already have.
 *
 * See: Failover and reconnection > RTMS server issue
 */
function handleServerFailureReconnect(meetingUuid, streamId, serverUrls) {
  log(streamId, 'RECONNECT', '========================================');
  log(streamId, 'RECONNECT', 'SCENARIO 1: RTMS SERVER FAILURE');
  log(streamId, 'RECONNECT', 'A new meeting.rtms_started arrived for an existing stream.');
  log(streamId, 'RECONNECT', 'Tearing down old connections and reconnecting with new server URLs.');
  log(streamId, 'RECONNECT', '========================================');

  // Close any existing sockets
  const existing = activeStreams.get(streamId);
  if (existing) {
    safeCloseWs(existing.signalingWs);
    safeCloseWs(existing.mediaWs);
  }

  // Create a fresh connection state with the new server URLs
  const conn = createStreamConnection(meetingUuid, streamId, serverUrls);
  conn.state = 'RECONNECTING';
  activeStreams.set(streamId, conn);

  // Connect immediately — the new server is ready for us
  connectToSignalingWebSocket(conn);
}


/**
 * SCENARIO 2: Signal Connection Down (App Issue)
 *
 * What happened:
 *   Our app's signaling WebSocket dropped (network issue, chaos mode, etc.).
 *   Since signaling controls the session, the RTMS server interrupted BOTH
 *   the signaling and media connections.
 *
 * What to do:
 *   Re-establish both signaling and media connections.
 *   The server waits ~60 seconds for us to reconnect before ending the stream.
 *
 * Trigger:
 *   meeting.rtms_interrupted webhook
 *
 * See: Failover and reconnection > App issue (signal connection down)
 */
function handleSignalingInterruptedReconnect(meetingUuid, streamId, serverUrls) {
  log(streamId, 'RECONNECT', '========================================');
  log(streamId, 'RECONNECT', 'SCENARIO 2: SIGNAL CONNECTION INTERRUPTED');
  log(streamId, 'RECONNECT', 'meeting.rtms_interrupted webhook received.');
  log(streamId, 'RECONNECT', 'Must re-establish BOTH signaling and media connections.');
  log(streamId, 'RECONNECT', 'Server allows ~60 seconds for signaling reconnection.');
  log(streamId, 'RECONNECT', '========================================');

  let conn = activeStreams.get(streamId);
  if (!conn) {
    // Edge case: we lost track of this stream. Create a new connection state.
    log(streamId, 'RECONNECT', 'No existing state found. Creating fresh connection.');
    conn = createStreamConnection(meetingUuid, streamId, serverUrls);
    activeStreams.set(streamId, conn);
  }

  // Close any lingering sockets
  safeCloseWs(conn.signalingWs);
  safeCloseWs(conn.mediaWs);

  // Update server URLs in case the webhook provides updated ones
  if (serverUrls) {
    conn.serverUrls = serverUrls;
  }

  conn.state = 'RECONNECTING';
  conn.reconnectAttempts++;

  // Reset chaos mode suppression counters so we can observe the cycle again
  conn.signalingKeepAliveSuppressed = 0;
  conn.mediaKeepAliveSuppressed = 0;

  const delay = getReconnectDelay(conn.reconnectAttempts);
  log(streamId, 'RECONNECT', `Reconnecting in ${delay}ms (attempt #${conn.reconnectAttempts})...`);

  setTimeout(() => {
    if (conn.state === 'STOPPED') return;
    connectToSignalingWebSocket(conn);
  }, delay);
}


/**
 * SCENARIO 3: Media Connection Down Only
 *
 * What happened:
 *   Only the media WebSocket dropped. The signaling connection is still alive.
 *   The server notified us through the signaling channel via either:
 *     - EVENT_UPDATE (msg_type 6) with event_type MEDIA_CONNECTION_INTERRUPTED (7)
 *     - STREAM_STATE_UPDATE (msg_type 8) with state INTERRUPTED (2) and reason 14
 *
 * What to do:
 *   Reconnect ONLY the media WebSocket. Signaling stays up.
 *   The server waits ~30 seconds for media reconnection.
 *
 * See: Failover and reconnection > App issue (data socket only)
 */
function handleMediaOnlyReconnect(conn) {
  log(conn.streamId, 'RECONNECT', 'Closing old media socket and scheduling reconnection...');

  // Close the old media socket
  safeCloseWs(conn.mediaWs);
  conn.mediaWs = null;

  conn.state = 'RECONNECTING';
  conn.reconnectAttempts++;

  // Reset media chaos counter so we can observe the cycle again
  conn.mediaKeepAliveSuppressed = 0;

  const delay = getReconnectDelay(conn.reconnectAttempts);
  log(conn.streamId, 'RECONNECT', `Reconnecting media in ${delay}ms (attempt #${conn.reconnectAttempts})...`);

  setTimeout(() => {
    if (conn.state === 'STOPPED') return;
    connectToMediaWebSocket(conn);
  }, delay);
}


/**
 * Clean up a stream completely. Called on meeting.rtms_stopped or STREAM_STATE TERMINATED.
 */
function cleanupStream(streamId) {
  const conn = activeStreams.get(streamId);
  if (!conn) return;

  conn.state = 'STOPPED';
  safeCloseWs(conn.signalingWs);
  safeCloseWs(conn.mediaWs);
  activeStreams.delete(streamId);

  log(streamId, 'CLEANUP', '========================================');
  log(streamId, 'CLEANUP', 'Stream cleaned up. Final stats:');
  log(streamId, 'CLEANUP', `  Transcripts received: ${conn.transcriptCount}`);
  log(streamId, 'CLEANUP', `  Signaling keep-alives: ${conn.signalingKeepAliveCount} total, ${conn.signalingKeepAliveSuppressed} suppressed`);
  log(streamId, 'CLEANUP', `  Media keep-alives: ${conn.mediaKeepAliveCount} total, ${conn.mediaKeepAliveSuppressed} suppressed`);
  log(streamId, 'CLEANUP', '========================================');
}


// ============================================================================
//  SECTION 8: WEBHOOK SERVER
//  Listens for Zoom webhook events that drive the RTMS lifecycle.
//  See: https://developers.zoom.us/docs/rtms/meetings/work-with-streams/
// ============================================================================

const app = express();
app.use(express.json());

app.post(WEBHOOK_PATH, (req, res) => {
  const { event, payload } = req.body;

  // ---------------------------------------------------------------
  // Zoom URL Validation Challenge
  // Required during initial webhook endpoint setup in Zoom Marketplace.
  // Zoom sends a plainToken; we hash it with our secret and return both.
  // See: https://developers.zoom.us/docs/api/webhooks/#verify-webhook-events
  // ---------------------------------------------------------------
  if (event === 'endpoint.url_validation' && payload?.plainToken) {
    const hash = crypto
      .createHmac('sha256', ZOOM_SECRET_TOKEN)
      .update(payload.plainToken)
      .digest('hex');
    log(null, 'WEBHOOK', 'Responding to Zoom URL validation challenge.');
    return res.json({ plainToken: payload.plainToken, encryptedToken: hash });
  }

  // Always acknowledge the webhook immediately to prevent Zoom retries
  res.sendStatus(200);

  log(null, 'WEBHOOK', `Received event: ${event}`);

  switch (event) {

    // ---------------------------------------------------------------
    // meeting.rtms_started
    //
    // Two cases:
    //   A) First time seeing this stream → Normal connection flow
    //   B) Stream already exists → SCENARIO 1 (RTMS server failure + restart)
    // ---------------------------------------------------------------
    case 'meeting.rtms_started': {
      const { meeting_uuid, rtms_stream_id, server_urls } = payload;
      log(rtms_stream_id, 'WEBHOOK', `meeting.rtms_started — meeting: ${meeting_uuid}`);

      if (activeStreams.has(rtms_stream_id)) {
        // Scenario 1: RTMS server failed and restarted. Reconnect with new URLs.
        handleServerFailureReconnect(meeting_uuid, rtms_stream_id, server_urls);
      } else {
        // Normal: first connection for this stream
        log(rtms_stream_id, 'WEBHOOK', 'New stream detected. Establishing initial connection...');
        const conn = createStreamConnection(meeting_uuid, rtms_stream_id, server_urls);
        activeStreams.set(rtms_stream_id, conn);
        connectToSignalingWebSocket(conn);
      }
      break;
    }

    // ---------------------------------------------------------------
    // meeting.rtms_interrupted
    //
    // SCENARIO 2: Our signaling connection dropped. The server interrupted
    // both signaling and media. We must reconnect both.
    // ---------------------------------------------------------------
    case 'meeting.rtms_interrupted': {
      const { meeting_uuid, rtms_stream_id, server_urls } = payload;
      log(rtms_stream_id, 'WEBHOOK', `meeting.rtms_interrupted — meeting: ${meeting_uuid}`);
      handleSignalingInterruptedReconnect(meeting_uuid, rtms_stream_id, server_urls);
      break;
    }

    // ---------------------------------------------------------------
    // meeting.rtms_stopped
    //
    // The stream has ended (meeting over, host stopped RTMS, user left, etc.).
    // Gracefully tear down all connections.
    // ---------------------------------------------------------------
    case 'meeting.rtms_stopped': {
      const { rtms_stream_id } = payload;
      log(rtms_stream_id, 'WEBHOOK', 'meeting.rtms_stopped — cleaning up.');
      cleanupStream(rtms_stream_id);
      break;
    }

    default:
      log(null, 'WEBHOOK', `Unhandled event: ${event}`);
  }
});


// ============================================================================
//  SECTION 9: START SERVER
// ============================================================================

app.listen(PORT, () => {
  console.log('');
  console.log('============================================================');
  console.log('  RTMS Reconnection & Chaos Mode Sample');
  console.log('============================================================');
  console.log(`  Server:    http://localhost:${PORT}`);
  console.log(`  Webhook:   POST http://localhost:${PORT}${WEBHOOK_PATH}`);
  console.log('');
  console.log('  Chaos Mode:');
  console.log(`    Suppress signaling keep-alive:    ${CHAOS_SUPPRESS_SIGNALING_KEEPALIVE ? 'YES (active!)' : 'no'}`);
  console.log(`    Suppress media keep-alive:        ${CHAOS_SUPPRESS_MEDIA_KEEPALIVE ? 'YES (active!)' : 'no'}`);
  console.log(`    Force-disconnect signaling after: ${CHAOS_FORCE_DISCONNECT_SIGNALING_AFTER_SEC ? CHAOS_FORCE_DISCONNECT_SIGNALING_AFTER_SEC + 's (active!)' : 'no'}`);
  console.log(`    Force-disconnect media after:     ${CHAOS_FORCE_DISCONNECT_MEDIA_AFTER_SEC ? CHAOS_FORCE_DISCONNECT_MEDIA_AFTER_SEC + 's (active!)' : 'no'}`);
  const chaosActive = CHAOS_SUPPRESS_SIGNALING_KEEPALIVE || CHAOS_SUPPRESS_MEDIA_KEEPALIVE
    || CHAOS_FORCE_DISCONNECT_SIGNALING_AFTER_SEC || CHAOS_FORCE_DISCONNECT_MEDIA_AFTER_SEC;
  if (chaosActive) {
    console.log('');
    console.log('  ** CHAOS MODE IS ACTIVE **');
    console.log('  Watch the logs to observe the disconnection and reconnection flow.');
  }
  console.log('');
  console.log('  Reconnection scenarios handled:');
  console.log('    1. RTMS Server Failure   → new meeting.rtms_started webhook');
  console.log('    2. Signal Conn Down      → meeting.rtms_interrupted webhook');
  console.log('    3. Media Conn Down Only  → MEDIA_CONNECTION_INTERRUPTED via signaling');
  console.log('');
  console.log('  Waiting for webhook events...');
  console.log('============================================================');
  console.log('');
});
