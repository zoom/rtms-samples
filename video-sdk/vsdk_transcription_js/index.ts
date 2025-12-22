import express from 'express';
import WebSocket from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import crypto from 'crypto';
import { config } from './src/config.js';
import { connectToSignalingWebSocket } from './src/websocket/signaling.js';
import type { ActiveConnections } from './src/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Main application
const app = express();
const port = config.port;

app.use(express.json());

app.use(express.static(path.join(__dirname, 'public')));

const activeConnections: ActiveConnections = new Map();

app.set('view engine', 'ejs');

app.post(config.webhookPath, async (req, res) => {
  console.log('Webhook request received');
  console.log(`Request method: ${req.method}`);
  console.log(`Request URL: ${req.url}`);
  console.log(`Request headers:`, JSON.stringify(req.headers, null, 2));

  const { event, payload } = req.body;
  console.log('Webhook event received:', event);
  console.log('Webhook payload:', JSON.stringify(payload, null, 2));

  if (event === 'endpoint.url_validation' && payload?.plainToken) {
    const hash = crypto.createHmac('sha256', config.zoomSecretToken)
      .update(payload.plainToken)
      .digest('hex');
    console.log('Webhook validation response sent');
    return res.json({
      plainToken: payload.plainToken,
      encryptedToken: hash,
    });
  } else {
    res.sendStatus(200);
    console.log('Webhook response sent (200 OK)');
  }

  if (event === 'session.rtms_started') {
    const sessionID = payload.session_id;
    const rtms_stream_id = payload.rtms_stream_id;
    const server_urls = payload.server_urls;
    console.log(`Starting RTMS for video session ${sessionID}`);

    activeConnections.set(sessionID, {
      sessionID: sessionID,
      streamId: rtms_stream_id,
      serverUrls: server_urls,
      shouldReconnect: true,
      signaling: { socket: null, state: 'connecting', lastKeepAlive: null },
      media: { socket: null, state: 'idle', lastKeepAlive: null },
    });

    connectToSignalingWebSocket(
      sessionID,
      rtms_stream_id,
      server_urls,
      activeConnections,
      config.clientId!,
      config.clientSecret!
    );
  }

  else if (event === 'session.rtms_stopped') {
    const sessionID = payload.session_id;
    console.log(`Stopping RTMS for video session ${sessionID}`);

    const conn = activeConnections.get(sessionID);
    if (conn) {
      conn.shouldReconnect = false;

      if (conn.signaling) {
        conn.signaling.state = 'closed';
        const ws = conn.signaling.socket;
        if (ws && typeof ws.close === 'function') {
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
});

const server = http.createServer(app);

server.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
  console.log(`Webhook available at http://localhost:${port}${config.webhookPath}`);
  console.log(`Frontend WebSocket available at ws://localhost:${port}/ws`);
});
