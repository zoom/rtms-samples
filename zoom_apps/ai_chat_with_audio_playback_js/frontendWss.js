import { WebSocketServer } from 'ws';
import fs from 'fs';
import path from 'path';
import { chatWithOpenRouter } from './chatWithOpenrouter.js';

const frontendClients = new Set();

// Shared services object that can be accessed by other modules
export const sharedServices = {
  frontendClients,
  broadcastToFrontendClients: null, // Will be set after function is defined
  textToSpeech: null // Will be set when Deepgram service is initialized
};

/**
 * Initialize the frontend WebSocket server.
 * @param {http.Server} server - The HTTP server instance.
 */
export function setupFrontendWss(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws, req) => {
    frontendClients.add(ws);
    console.log('🌐 Frontend client connected from', req.socket.remoteAddress);

    // ✅ Send initial 'ready' message
    ws.send(JSON.stringify({ type: 'ready' }));

    ws.on('message', async (raw) => {
      try {
        const message = JSON.parse(raw);

        switch (message.type) {
          case 'client_ready':
           
            console.log('📣 Client: ',message, 'is ready – sending test messages');

            // // 📝 Send a plain text message
            // ws.send(JSON.stringify({
            //   type: 'text',
            //   data: 'Hello from the server 👋'
            // }));

            // // 🌐 Send a basic HTML snippet
            ws.send(JSON.stringify({
              type: 'html',
              data: '<p>Hello world from backend websocket</p>'
            }));
            break;

          case 'text':
            console.log('💬 Received text from user:', message.data);
            
            try {
              // Get response from OpenRouter chatbot
              const aiResponse = await chatWithOpenRouter(message.data);
              console.log('🤖 AI Response:', aiResponse);

              // Debug logging for shared services
              console.log('🔍 Debug - sharedServices available:', !!sharedServices);
              console.log('🔍 Debug - textToSpeech function:', !!sharedServices?.textToSpeech);
              console.log('🔍 Debug - broadcastToFrontendClients function:', !!sharedServices?.broadcastToFrontendClients);

              // Send text response to frontend clients first
              if (sharedServices?.broadcastToFrontendClients) {
                sharedServices.broadcastToFrontendClients({
                  type: 'text',
                  data: aiResponse,
                  metadata: {
                    source: 'ai_response',
                    originalText: message.data,
                    timestamp: Date.now()
                  }
                });
                console.log('✅ AI response text sent to frontend clients');
              }

              // Convert AI response to speech using Deepgram
              if (sharedServices?.textToSpeech && sharedServices?.broadcastToFrontendClients) {
                console.log('🎤 Converting AI response to speech...');
                const base64Audio = await sharedServices.textToSpeech(aiResponse);
                
                // Send audio to frontend clients
                sharedServices.broadcastToFrontendClients({
                  type: 'audio',
                  data: base64Audio,
                  metadata: {
                    source: 'ai_response',
                    originalText: message.data,
                    aiResponse: aiResponse,
                    timestamp: Date.now()
                  }
                });
                
                console.log('✅ AI response audio sent to frontend clients');
              } else {
                console.warn('⚠️ Shared services not available for text-to-speech');
                if (!sharedServices) {
                  console.warn('   - sharedServices is null/undefined');
                } else {
                  console.warn('   - textToSpeech available:', !!sharedServices.textToSpeech);
                  console.warn('   - broadcastToFrontendClients available:', !!sharedServices.broadcastToFrontendClients);
                }
              }
            } catch (error) {
              console.error('❌ Error processing user text:', error);
              // Send error message back to client
              ws.send(JSON.stringify({
                type: 'error',
                data: 'Sorry, I encountered an error processing your message. Please try again.'
              }));
            }
            break;

          case 'heartbeat':
            break;

          case 'end':
            console.log('⏹️ End of audio stream from client');
            break;

          default:
            console.warn('⚠️ Unknown message type:', message.type);
            break;
        }
      } catch (err) {
        console.error('❌ Error parsing message from client:', err);
        ws.send(JSON.stringify({ type: 'error', data: 'Invalid message format' }));
      }
    });

    const interval = setInterval(() => {
      if (ws.readyState === ws.OPEN) {
        ws.ping(); // Sends a ping frame
      }
    }, 30000); // every 30 seconds



    ws.on('close', () => {
      clearInterval(interval);
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

// Set the broadcast function in shared services after it's defined
sharedServices.broadcastToFrontendClients = broadcastToFrontendClients;
