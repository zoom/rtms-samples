const { verifySocketJoin } = require('../middleware/security');

/**
 * WebSocket Server for real-time state synchronization
 */
class WebSocketServer {
  constructor(io) {
    this.io = io;
    this.connections = new Map(); // meetingId -> Set of socket IDs

    this.setupEventHandlers();
  }

  setupEventHandlers() {
    this.io.on('connection', (socket) => {
      console.log(`WebSocket client connected: ${socket.id}`);

      // Handle client joining a meeting room (with Zoom App context verification)
      socket.on('join_meeting', (payload, ack) => {
        const isObj = payload && typeof payload === 'object';
        const meetingId = isObj ? payload.meetingId : payload;
        const contextHeader =
          (isObj ? payload.zoomAppContext : null) ||
          socket.handshake?.auth?.zoomAppContext ||
          socket.handshake?.headers?.['x-zoom-app-context'];
        const authToken =
          (isObj ? payload.authToken : null) ||
          socket.handshake?.auth?.authToken ||
          socket.handshake?.headers?.['x-zoom-app-token'];
        const session = socket.request?.session || null;

        const verification = verifySocketJoin({
          meetingId,
          contextHeader,
          authToken,
          session
        });

        if (!verification.authorized) {
          console.warn(`Rejected join_meeting for socket ${socket.id}: ${verification.reason}`);
          socket.emit('join_error', { error: 'Unauthorized meeting join', reason: verification.reason });
          if (typeof ack === 'function') {
            ack({ ok: false, error: 'Unauthorized meeting join', reason: verification.reason });
          }
          return;
        }

        socket.zoomContext = verification.context;
        console.log(`Client ${socket.id} joining meeting ${meetingId}`);
        socket.join(meetingId);

        if (!this.connections.has(meetingId)) {
          this.connections.set(meetingId, new Set());
        }
        this.connections.get(meetingId).add(socket.id);

        if (typeof ack === 'function') {
          ack({ ok: true, meetingId });
        }
      });

      // Handle client leaving a meeting room
      socket.on('leave_meeting', (meetingId) => {
        console.log(`Client ${socket.id} leaving meeting ${meetingId}`);
        socket.leave(meetingId);

        if (this.connections.has(meetingId)) {
          this.connections.get(meetingId).delete(socket.id);
          if (this.connections.get(meetingId).size === 0) {
            this.connections.delete(meetingId);
          }
        }
      });

      // Handle disconnection
      socket.on('disconnect', () => {
        console.log(`WebSocket client disconnected: ${socket.id}`);

        this.connections.forEach((sockets, meetingId) => {
          if (sockets.has(socket.id)) {
            sockets.delete(socket.id);
            if (sockets.size === 0) {
              this.connections.delete(meetingId);
            }
          }
        });
      });
    });
  }

  /**
   * Broadcast consent state update to all clients in a meeting
   */
  broadcastConsentUpdate(meetingId, state) {
    console.log(`Broadcasting consent update to meeting ${meetingId}`);
    this.io.to(meetingId).emit('consent_state_update', state);
  }

  /**
   * Broadcast full state to all clients in a meeting
   */
  broadcastFullState(meetingId, state) {
    console.log(`Broadcasting full state to meeting ${meetingId}`);
    this.io.to(meetingId).emit('full_state', state);
  }

  /**
   * Broadcast RTMS status change
   */
  broadcastRTMSStatus(meetingId, status, reason = null) {
    console.log(`Broadcasting RTMS status to meeting ${meetingId}: ${status}`);
    this.io.to(meetingId).emit('rtms_status_changed', {
      meetingId,
      rtmsStatus: status,
      rtmsPausedReason: reason
    });
  }

  /**
   * Get count of connected clients for a meeting
   */
  getConnectionCount(meetingId) {
    return this.connections.get(meetingId)?.size || 0;
  }
}

module.exports = WebSocketServer;
