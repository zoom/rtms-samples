import { WebSocketServer } from 'ws';

const frontendClients = new Map();

export function setupFrontendWss(server, handlers = {}) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws, req) => {
    frontendClients.set(ws, { connectedAt: Date.now() });
    console.log('[Zoom App] Frontend connected from', req.socket.remoteAddress);

    ws.send(JSON.stringify({ type: 'ready' }));

    ws.on('message', async (raw) => {
      let message;
      try {
        message = JSON.parse(raw);
      } catch (error) {
        ws.send(JSON.stringify({ type: 'error', data: 'Invalid JSON message' }));
        return;
      }

      try {
        switch (message.type) {
          case 'client_ready':
            frontendClients.set(ws, {
              ...frontendClients.get(ws),
              ...(message.data || {}),
              readyAt: Date.now(),
            });
            await handlers.onClientReady?.(message.data || {}, ws);
            break;
          case 'text':
            await handlers.onTextMessage?.({
              text: String(message.data || ''),
              metadata: frontendClients.get(ws) || {},
              ws,
            });
            break;
          case 'playback_interrupted':
            await handlers.onPlaybackInterrupted?.({
              data: message.data || {},
              metadata: frontendClients.get(ws) || {},
              ws,
            });
            break;
          case 'heartbeat':
            ws.send(JSON.stringify({ type: 'heartbeat_ack', timestamp: Date.now() }));
            break;
          default:
            console.warn('[Zoom App] Unknown frontend message type:', message.type);
            break;
        }
      } catch (error) {
        console.error('[Zoom App] Error handling frontend message:', error);
        ws.send(JSON.stringify({ type: 'error', data: error.message || 'Frontend message failed' }));
      }
    });

    const interval = setInterval(() => {
      if (ws.readyState === ws.OPEN) {
        ws.ping();
      }
    }, 30000);

    ws.on('close', () => {
      clearInterval(interval);
      frontendClients.delete(ws);
      console.log('[Zoom App] Frontend disconnected');
    });

    ws.on('error', (error) => {
      clearInterval(interval);
      frontendClients.delete(ws);
      console.error('[Zoom App] Frontend WebSocket error:', error.message);
    });
  });

  console.log('[Zoom App] Frontend WebSocket server initialized at /ws');
  return wss;
}

export function broadcastToFrontendClients(message) {
  const json = typeof message === 'string' ? message : JSON.stringify(message);
  for (const client of frontendClients.keys()) {
    if (client.readyState === client.OPEN) {
      client.send(json);
    }
  }
}

export function frontendClientCount() {
  return frontendClients.size;
}
