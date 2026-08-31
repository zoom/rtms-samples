import { WebSocketServer } from 'ws';
import { FileLogger } from './utils/FileLogger.js';

export class FrontendWssManager {
  constructor(options = {}) {
    this.config = options.config || {};
    this.server = options.server || null;
    this.logger = options.logger || FileLogger;
    this.authorizeRegistration =
      options.authorizeRegistration || this.config.authorizeRegistration || null;
    this.frontendClients = new Set();
    this.broadcast = this.broadcastToFrontendClients.bind(this);
  }

  setup() {
    if (!this.server || this.config.frontendWssEnabled === false) {
      this.logger.log('[FrontendWssManager] 🧩 Frontend WSS skipped');
      return;
    }

    this.wss = new WebSocketServer({
      server: this.server,
      path: this.config.frontendWssPath,
      maxPayload: Number(this.config.frontendWssMaxPayloadBytes) || 64 * 1024
    });

    const pingInterval = 10000;
    this.pingTimer = setInterval(() => {
      const pingMsg = JSON.stringify({ type: 'ping' });
      for (const client of this.frontendClients) {
        if (client.readyState === 1) {
          client.send(pingMsg);
          // this.logger.log('[FrontendWssManager] 🔄 Ping sent to frontend client');
        }
      }
    }, pingInterval);

    this.wss.on('connection', (ws, request) => {
      this.frontendClients.add(ws);
      this.logger.log('[FrontendWssManager] 🌐 Frontend client connected (unregistered, registering now...)');

      // Kick if not registered within 15 seconds (increased from 5s to allow Zoom SDK context retrieval)
      const registrationTimeout = setTimeout(() => {
        if (!ws.meetingUUID || !ws.userID) {
          this.logger.log('[FrontendWssManager] ❌ Registration timeout. Closing connection.');
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'error', message: 'Registration timeout' }));
          }
          ws.terminate();
        }
      }, 15000);

      ws.send(JSON.stringify({ type: 'connected', message: 'Connected to RTMS backend. Please register.' }));

      ws.on('message', async (message) => {
        try {
          const data = JSON.parse(message.toString());
          
          if (data.type === 'pong') {
            // this.logger.log('[FrontendWssManager] 🏓 Pong received from frontend client');
            return;
          }

          if (data.type === 'register') {
            const { meetingUUID, userID, token } = data;
            const registration = await this.validateRegistration({
              meetingUUID,
              userID,
              token,
              request,
              socket: ws
            });

            if (registration.authorized) {
              ws.meetingUUID = String(registration.meetingUUID ?? meetingUUID);
              ws.userID = String(registration.userID ?? userID);
              clearTimeout(registrationTimeout);
              ws.send(JSON.stringify({
                type: 'registration_success',
                meetingUUID: ws.meetingUUID,
                userID: ws.userID
              }));
              this.logger.log(`[FrontendWssManager] ✅ Client registered: ${ws.userID} for meeting ${ws.meetingUUID}`);
            } else {
              this.logger.warn('[FrontendWssManager] Registration rejected');
              ws.send(JSON.stringify({ type: 'error', message: 'Registration unauthorized' }));
              ws.terminate();
            }
            return;
          }
        } catch (e) {
          this.logger.warn(`[FrontendWssManager] Invalid client message: ${e.message}`);
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'error', message: 'Invalid message' }));
          }
        }
      });

      ws.on('close', () => {
        clearTimeout(registrationTimeout);
        this.frontendClients.delete(ws);
        const info = ws.userID && ws.meetingUUID ? `: ${ws.userID} from ${ws.meetingUUID}` : '';
        this.logger.log(`[FrontendWssManager] ❌ Frontend client disconnected${info}`);
      });

      ws.on('error', (err) => {
        clearTimeout(registrationTimeout);
        this.frontendClients.delete(ws);
        this.logger.error('⚠️ Frontend WS error:', err);
      });
    });

    this.logger.log(`[FrontendWssManager] 🧩 Frontend WSS initialized at ${this.config.frontendWssPath}`);
  }

  async validateRegistration(context) {
    if (!context.meetingUUID || context.userID == null || !this.authorizeRegistration) {
      return { authorized: false };
    }

    const result = await this.authorizeRegistration(context);
    if (result === true) {
      return {
        authorized: true,
        meetingUUID: context.meetingUUID,
        userID: context.userID
      };
    }
    if (result && typeof result === 'object' && result.authorized === true) {
      return result;
    }
    return { authorized: false };
  }

  broadcastToFrontendClients(message) {
    const json = typeof message === 'string' ? message : JSON.stringify(message);
    for (const client of this.frontendClients) {
      if (client.readyState === 1 && client.meetingUUID && client.userID) {
        client.send(json);
      }
    }
  }

  /**
   * Broadcast to all clients in a specific meeting/session
   * @param {string} meetingUUID 
   * @param {Object|string} message 
   */
  broadcastToMeeting(meetingUUID, message) {
    const json = typeof message === 'string' ? message : JSON.stringify(message);
    for (const client of this.frontendClients) {
      if (client.readyState === 1 && client.meetingUUID === String(meetingUUID)) {
        client.send(json);
      }
    }
  }

  /**
   * Broadcast to a specific user in a specific meeting/session
   * @param {string} meetingUUID 
   * @param {string} userID 
   * @param {Object|string} message 
   */
  broadcastToUser(meetingUUID, userID, message) {
    const json = typeof message === 'string' ? message : JSON.stringify(message);
    for (const client of this.frontendClients) {
      if (
        client.readyState === 1 &&
        client.meetingUUID === String(meetingUUID) &&
        client.userID === String(userID)
      ) {
        client.send(json);
      }
    }
  }

  stop() {
    // Clear ping timer
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }

    // Close all active client connections
    for (const client of this.frontendClients) {
      try {
        if (client.readyState === 1 || client.readyState === 0) { // OPEN or CONNECTING
          client.close(1000, 'Server shutting down');
        }
      } catch (err) {
        this.logger.error('[FrontendWssManager] Error closing client connection:', err);
      }
    }

    // Clear the clients set
    this.frontendClients.clear();

    // Close the WebSocket server
    if (this.wss) {
      try {
        this.wss.close(() => {
          this.logger.log('[FrontendWssManager] WebSocket server closed');
        });
        this.wss = null;
      } catch (err) {
        this.logger.error('[FrontendWssManager] Error closing WebSocket server:', err);
      }
    }

    this.logger.log('[FrontendWssManager] Stopped and cleaned up all connections');
  }
}
