import { WebSocketServer } from 'ws';

const frontendClients = new Set();

/**
 * Initialize the frontend WebSocket server.
 * @param {http.Server} server - The HTTP server instance.
 */
export function setupFrontendWss(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws) => {
    frontendClients.add(ws);
    console.log('🌐 Frontend client connected');

    ws.send('✅ Connected to RTMS backend');

    ws.on('close', () => {
      frontendClients.delete(ws);
      console.log('❌ Frontend client disconnected');
    });

    ws.on('error', (err) => {
      frontendClients.delete(ws);
      console.error('⚠️ WebSocket error:', err);
    });
  });

  console.log('🧩 Frontend WebSocket server initialized at /ws');
}

/**
 * Broadcast a message to all connected frontend clients.
 * @param {Object|string} message - JSON object or string.
 */
export function broadcastToFrontendClients(message) {
  const json = typeof message === 'string' ? message : JSON.stringify(message);
  for (const client of frontendClients) {
    if (client.readyState === 1) { // WebSocket.OPEN
      client.send(json);
    }
  }
}
