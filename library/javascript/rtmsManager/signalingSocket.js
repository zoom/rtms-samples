import WebSocket from 'ws';
import { generateRTMSSignature } from './utils/signatureHelper.js';
import { buildRtmsEntityPayload } from './utils/rtmsEntityHelper.js';
import { handleSignalingMessage } from './signalingSocketMessageHandler.js';
import { FileLogger } from './utils/FileLogger.js';
import { RTMSError } from './utils/RTMSError.js';

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

function getWebSocketHost(url) {
  try {
    return new URL(url).host;
  } catch (_error) {
    return 'unknown';
  }
}

function measureSignalingPingRtt(socket, meetingUuid, streamId, serverUrls, conn, emit) {
  if (!socket || typeof socket.ping !== 'function') return;

  const startedAt = Date.now();
  const host = getWebSocketHost(serverUrls);
  const timeoutMs = Number(conn.config?.signalingPingTimeoutMs || 5000);
  let finished = false;

  const cleanup = () => {
    socket.off?.('pong', onPong);
    socket.off?.('close', onClose);
    clearTimeout(timer);
  };
  const finish = (callback) => {
    if (finished) return;
    finished = true;
    cleanup();
    callback();
  };
  const onPong = () => {
    finish(() => {
      const rttMs = Date.now() - startedAt;
      conn.setPingRtt?.(rttMs);
      FileLogger.log(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] Ping RTT ${rttMs}ms host=${host}`);
      emit('signaling_ping_rtt', {
        type: 'signaling_ping_rtt',
        rtmsId: meetingUuid,
        meetingId: meetingUuid,
        streamId,
        productType: conn.rtmsType,
        rttMs,
        signalingHost: host,
        at: new Date().toISOString(),
        timestamp: Date.now()
      });
    });
  };
  const onClose = () => {
    finish(() => {});
  };
  const timer = setTimeout(() => {
    finish(() => {
      FileLogger.warn(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] Ping RTT probe timed out after ${timeoutMs}ms host=${host}`);
    });
  }, timeoutMs);

  socket.once('pong', onPong);
  socket.once('close', onClose);

  try {
    socket.ping();
  } catch (error) {
    finish(() => {
      FileLogger.warn(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] Ping RTT probe failed: ${error.message}`);
    });
  }
}

/**
 * Connect to the RTMS signaling WebSocket
 * Uses split mode only - each media type gets its own connection
 */
export function connectToSignalingWebSocket(
  meetingUuid,
  streamId,
  serverUrls,
  conn,
  clientId,
  clientSecret,
  emit,
  mediaTypesFlag = 32
) {
  FileLogger.log(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] Connecting...`);

  conn.meetingUuid = meetingUuid;
  conn.streamId = streamId;
  conn.serverUrls = serverUrls;
  if (!conn.mediaTypesFlag) conn.mediaTypesFlag = mediaTypesFlag;

  if (conn._signalingConnectLocked) {
    FileLogger.warn(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] Duplicate connect attempt blocked (connect already in progress).`);
    return;
  }

  // Guard: prevent duplicate signaling connections
  if (conn.signaling && conn.signaling.socket) {
    const existingState = conn.signaling.socket.readyState;
    if (existingState !== WebSocket.CLOSED) {
      FileLogger.warn(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] Duplicate connect attempt blocked (readyState: ${existingState}, state: ${conn.signaling.state}).`);
      return;
    }
  }

  // Clear any pending reconnect timer to prevent overlapping reconnects
  if (conn._signalingReconnectTimer) {
    clearTimeout(conn._signalingReconnectTimer);
    conn._signalingReconnectTimer = null;
  }
  if (conn._duplicateSignalRetryTimer) {
    clearTimeout(conn._duplicateSignalRetryTimer);
    conn._duplicateSignalRetryTimer = null;
  }

  if (!serverUrls || typeof serverUrls !== 'string' || !serverUrls.startsWith('ws')) {
    const error = RTMSError.fromCode('CONNECTION_FAILED', {
      meetingId: meetingUuid,
      streamId
    });
    FileLogger.error(`[Signaling] ${error.toShortString()}`);
    emit('error', error);
    conn.shouldReconnect = false;
    return;
  }

  let signalingWs;
  try {
    conn._signalingConnectLocked = true;
    signalingWs = new WebSocket(serverUrls);
    conn._signalingConnectSocket = signalingWs;
  } catch (err) {
    conn._signalingConnectLocked = false;
    conn._signalingConnectSocket = null;
    const error = new RTMSError('CONNECTION_FAILED', `Failed to create WebSocket: ${err.message}`, {
      meetingId: meetingUuid,
      streamId,
      cause: err
    });
    FileLogger.error(`[Signaling] ${error.toShortString()}`);
    emit('error', error);
    return;
  }

  conn.signaling.socket = signalingWs;
  conn.signaling.state = 'connecting';
  conn._signalingHandshakeInFlight = false;

  signalingWs.on('open', () => {
    try {
      if (conn.signaling.socket !== signalingWs) {
        FileLogger.warn(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] Opened stale signaling socket; closing it.`);
        closeSocketQuietly(signalingWs);
        return;
      }

      FileLogger.log(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] Connected, sending handshake`);
      measureSignalingPingRtt(signalingWs, meetingUuid, streamId, serverUrls, conn, emit);
      
      if (!conn.shouldReconnect) {
        FileLogger.warn(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] Aborting - RTMS stopped`);
        signalingWs.close();
        return;
      }

      const signature = generateRTMSSignature(meetingUuid, streamId, clientId, clientSecret);

      const handshakeMsg = {
        msg_type: 1,
        protocol_version: 1,
        ...buildRtmsEntityPayload(conn.rtmsType, meetingUuid),
        rtms_stream_id: streamId,
        sequence: Math.floor(Math.random() * 1e9),
        signature,
        buffer_data: false,
      };

      conn._signalingHandshakeInFlight = true;
      signalingWs.send(JSON.stringify(handshakeMsg));
      conn.signaling.state = 'authenticated';
    } catch (err) {
      const error = new RTMSError('SIGNALING_ERROR', `Handshake failed: ${err.message}`, {
        meetingId: meetingUuid,
        streamId,
        cause: err
      });
      FileLogger.error(`[Signaling] ${error.toShortString()}`);
      emit('error', error);
      conn._signalingHandshakeInFlight = false;
      conn.signaling.state = 'error';
      signalingWs.close();
    }
  });

  signalingWs.on('message', (data) => {
    if (conn.signaling.socket !== signalingWs) {
      FileLogger.warn(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] Ignoring message from stale signaling socket.`);
      return;
    }
    try {
      handleSignalingMessage(data, meetingUuid, streamId, signalingWs, conn, emit, mediaTypesFlag, clientId, clientSecret);
    } catch (err) {
      const error = new RTMSError('SIGNALING_ERROR', `Failed to handle signaling message: ${err.message}`, {
        meetingId: meetingUuid,
        streamId,
        cause: err
      });
      FileLogger.error(`[Signaling] ${error.toShortString()}`);
      emit('error', error);
    }
  });

  signalingWs.on('close', (code, reason) => {
    FileLogger.log(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] Closed (code: ${code})`);
    conn._signalingHandshakeInFlight = false;
    conn.signaling.state = 'closed';
    releaseSignalingConnectLock(conn, signalingWs);

    if (conn.signaling.socket === signalingWs) {
      conn.signaling.socket = null;
    }

    if (conn._suppressNextSignalingCloseReconnect === signalingWs) {
      conn._suppressNextSignalingCloseReconnect = null;
      return;
    }

    if (conn.shouldReconnect) {
      FileLogger.log(`[Signaling] [${conn.rtmsType},${meetingUuid},${streamId}] Reconnecting in 3s...`);
      conn._signalingReconnectTimer = setTimeout(() => {
        conn._signalingReconnectTimer = null;
        if (conn.shouldReconnect) {
          connectToSignalingWebSocket(
            meetingUuid,
            streamId,
            conn.serverUrls,
            conn,
            clientId,
            clientSecret,
            emit,
            conn.mediaTypesFlag
          );
        }
      }, 3000);
    }
  });

  signalingWs.on('error', (err) => {
    const error = new RTMSError('SIGNALING_ERROR', `WebSocket error: ${err.message}`, {
      meetingId: meetingUuid,
      streamId,
      cause: err
    });
    FileLogger.error(`[Signaling] ${error.toShortString()}`);
    emit('error', error);
    conn._signalingHandshakeInFlight = false;
    conn.signaling.state = 'error';
    releaseSignalingConnectLock(conn, signalingWs);
  });
}
