import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { getAccessTokenForEventWebsocket } from './utils/zoomClientCredentialsToken.js';
import { FileLogger } from './utils/FileLogger.js';

export class WebsocketManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.config = options.config || {};
    this.logger = options.logger || FileLogger;
    this.ws = null;
    this.reconnectInterval = null;
    this.heartbeatInterval = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.reconnectDelay = 5000; // 5s initial, exponential backoff
  }

  async connect() {
    try {
      const { zoomWSURLForEvents: baseWsUrl, clientId, clientSecret } = this.config;
      if (!baseWsUrl || !clientId || !clientSecret) {
        throw new Error('[WebsocketManager] Missing env vars for websocket mode');
      }

      const accessToken = await getAccessTokenForEventWebsocket(clientId, clientSecret);
      const fullWsUrl = `${baseWsUrl}&access_token=${accessToken}`;

      this.logger.log(`[WebsocketManager] 🔗 Connecting to Event WebSocket (attempt ${this.reconnectAttempts + 1}):`, fullWsUrl);

      this.ws = new WebSocket(fullWsUrl);

      this.ws.on('open', () => {
        this.logger.log('[WebsocketManager] ✅ Event WebSocket connected');
        this.reconnectAttempts = 0;
        this.sendHeartbeat();
        this.heartbeatInterval = setInterval(() => this.sendHeartbeat(), 30000);
      });

      this.ws.on('message', async (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.module === 'message' && msg.content) {
            const eventData = JSON.parse(msg.content);
            const event = eventData.event;
            const payload = eventData.payload || {};

            if (
              event === 'rtms.concurrency_limited' ||
              event === 'rtms.concurrency_near_limit' ||
              event === 'rtms.start_failed' ||
              event.endsWith('rtms_interrupted')
            ) {
              this.logger.warn(`[WebsocketManager] ⚠️ Critical RTMS event received: ${event}`, JSON.stringify(payload, null, 2));
            }
            else if (
              event.endsWith('rtms_started')|| event.endsWith('rtms_stopped')
            ) {
              this.logger.log(`[WebsocketManager] RTMS event received: ${event}`, JSON.stringify(payload, null, 2));
            }
            
            this.emit('event', event, payload);
          }
        } catch (err) {
          this.logger.error('[WebsocketManager] Error processing event WS message:', err);
        }
      });

      this.ws.on('error', (err) => {
        this.logger.error('[WebsocketManager] Event WebSocket error:', err);
        this.scheduleReconnect();
      });

      this.ws.on('close', (code, reason) => {
        this.logger.log(`[WebsocketManager] Event WebSocket closed (code: ${code}, reason: ${reason || 'unknown'})`);
        clearInterval(this.heartbeatInterval);
        this.scheduleReconnect();
      });
    } catch (err) {
      this.logger.error('[WebsocketManager] Failed to connect to Event WS:', err);
      this.scheduleReconnect();
    }
  }

  sendHeartbeat() {
    if (this.ws && this.ws.readyState === 1) { // OPEN
      this.ws.send(JSON.stringify({ module: 'heartbeat' }));
    }
  }

  scheduleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.logger.error('[WebsocketManager] Max reconnect attempts reached. Giving up.');
      return;
    }

    clearTimeout(this.reconnectInterval);
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts);
    this.reconnectAttempts++;
    this.logger.log(`[WebsocketManager] Reconnecting in ${delay / 1000}s... (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
    this.reconnectInterval = setTimeout(() => this.connect(), delay);
  }

  async start() {
    await this.connect();
  }

  stop() {
    if (this.reconnectInterval) clearTimeout(this.reconnectInterval);
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

export default WebsocketManager;
