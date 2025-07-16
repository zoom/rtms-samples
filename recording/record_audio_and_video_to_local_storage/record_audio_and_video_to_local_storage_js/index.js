import express from 'express';
import WebSocket from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import https from 'https';


import { config } from './config.js';
import { connectToSignalingWebSocket } from './signalingSocket.js';
import { s2sZoomApiRequest } from './s2sZoomApiClient.js';
import { setupFrontendWss, broadcastToFrontendClients } from './frontendWss.js';



import { convertMeetingMedia } from './convertMeetingMedia.js';
import { muxFirstAudioVideo } from './muxFirstAudioVideo.js';

const app = express();
const port = config.port;

app.use(express.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

const activeConnections = new Map();

app.set('view engine', 'ejs');

app.get('/', (req, res) => {
  res.render('index', {
    websocketUrl: config.ws_url || 'wss://yoururl.ngrok.com/ws'
  });
});



if (config.mode === "webhook") {
  console.log("wehook mode");
  // Webhook handler
  app.post(config.webhookPath, async (req, res) => {
    const { event, payload } = req.body;
    console.log('Webhook received:', event);

    if (event === 'endpoint.url_validation' && payload?.plainToken) {
      const crypto = await import('crypto');
      const hash = crypto.createHmac('sha256', config.zoomSecretToken)
        .update(payload.plainToken)
        .digest('hex');
      return res.json({
        plainToken: payload.plainToken,
        encryptedToken: hash,
      });
    }


    //   {
    //   "event": "meeting.rtms_started",
    //   "event_ts": 1732313171881,
    //   "payload": {
    //     "meeting_uuid": "4444AAAiAAAAAiAiAiiAii==",
    //     "operator_id": "xxxxxxxxxxx",
    //     "rtms_stream_id": "609340fb2a7946909659956c8aa9250c",
    //     "server_urls": "wss://127.0.0.1:443"
    // }

    else if (event === 'meeting.rtms_started') {
      const { meeting_uuid, rtms_stream_id, server_urls } = payload;
      console.log(`Starting RTMS for meeting ${meeting_uuid}`);

      activeConnections.set(meeting_uuid, {
        meetingUuid: meeting_uuid,
        streamId: rtms_stream_id,
        serverUrls: server_urls,
        shouldReconnect: true,
        signaling: { socket: null, state: 'connecting', lastKeepAlive: null },
        media: { socket: null, state: 'idle', lastKeepAlive: null },
      });

      connectToSignalingWebSocket(
        meeting_uuid,
        rtms_stream_id,
        server_urls,
        activeConnections,
        config.clientId,
        config.clientSecret,
        broadcastToFrontendClients // pass broadcast if needed
      );
    }

    // {
    //    "event": "meeting.rtms_stopped",
    //    "event_ts": 1732313171881,
    //    "payload": {
    //        "meeting_uuid": "4444AAAiAAAAAiAiAiiAii==",
    //        "rtms_stream_id": "609340fb2a7946909659956c8aa9250c",
    //        "stop_reason": 6
    //    }
    // }

    else if (event === 'meeting.rtms_stopped') {
      const { meeting_uuid } = payload;
      console.log(`Stopping RTMS for meeting ${meeting_uuid}`);


        await convertMeetingMedia(meeting_uuid);
        await muxFirstAudioVideo(meeting_uuid);



      const conn = activeConnections.get(meeting_uuid);
      if (conn) {
        conn.shouldReconnect = false;

        // Explicitly update states
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

        // Finally, delete from the map
        activeConnections.delete(meeting_uuid);
      }
    }


    res.sendStatus(200);
  });
}

else if (config.mode === 'websocket') {
  console.log("websocket mode");
  const baseWsUrl = config.zoomWSURLForEvents;
  const clientId = config.clientId;
  const clientSecret = config.clientSecret;

  if (!baseWsUrl || !clientId || !clientSecret) {
    console.error('❌ Missing required env vars: ZOOM_EVENT_WS_BASE, ZOOM_CLIENT_ID, or ZOOM_CLIENT_SECRET');

  }

  // === Get Zoom Access Token (client_credentials grant) ===
  const accessToken = await new Promise((resolve, reject) => {
    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const options = {
      method: 'POST',
      hostname: 'zoom.us',
      path: '/oauth/token?grant_type=client_credentials',
      headers: {
        'Authorization': `Basic ${credentials}`
      }
    };

    const req = https.request(options, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          const tokenData = JSON.parse(body);
          console.log('✅ Zoom access token received.');
          resolve(tokenData.access_token);
        } else {
          console.error(`❌ Zoom token request failed: ${res.statusCode} ${body}`);
          resolve(null);
        }
      });
    });

    req.on('error', (err) => {
      console.error('❌ HTTPS error requesting token:', err.message);
      resolve(null);
    });

    req.end();
  });

  if (!accessToken) {
    console.error('No access token returned');
  }

  // === Connect to WebSocket ===
  const fullWsUrl = `${baseWsUrl}&access_token=${accessToken}`;
  console.log(`🔗 Full WebSocket URL: ${fullWsUrl}`);

  const ws = new WebSocket(fullWsUrl);

  ws.on('open', () => {
    console.log('✅ WebSocket connection established.');
    ws.send(JSON.stringify({ module: 'heartbeat' }));
    console.log('💓 Sent initial heartbeat');

    const interval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ module: 'heartbeat' }));
        console.log('💓 Heartbeat sent');
      } else {
        clearInterval(interval);
      }
    }, 30000);
  });

  ws.on('message', async (message) => {
    console.log('📥 Received message from Zoom Event WebSocket');
    console.debug(`🔍 Raw Message:\n${message}`);

    try {
      const msg = JSON.parse(message);
      if (msg.module === 'message' && msg.content) {
        const eventData = JSON.parse(msg.content);
        const event = eventData.event;
        const payload = eventData.payload || {};

        console.log(`🧠 Parsed Event: ${event}`);
        console.debug(`📦 Payload:`, payload);

        if (event === 'meeting.rtms_started') {
          const { meeting_uuid, rtms_stream_id, server_urls } = payload;
          console.log(`🚀 Triggering signaling WebSocket for ${meeting_uuid}`);

          activeConnections.set(meeting_uuid, {
            meetingUuid: meeting_uuid,
            streamId: rtms_stream_id,
            serverUrls: server_urls,
            shouldReconnect: true,
            signaling: { socket: null, state: 'connecting', lastKeepAlive: null },
            media: { socket: null, state: 'idle', lastKeepAlive: null },
          });

          connectToSignalingWebSocket(
            meeting_uuid,
            rtms_stream_id,
            server_urls,
            activeConnections,
            clientId,
            clientSecret,
            () => { } // optional broadcastToFrontendClients
          );
        }

        if (event === 'meeting.rtms_stopped') {
          const { meeting_uuid } = payload;
          console.log(`🛑 Closing signaling for ${meeting_uuid}`);

          const conn = activeConnections.get(meeting_uuid);
          if (conn) {
            for (const key in conn) {
              try {
                conn[key]?.close?.();
              } catch (err) {
                console.warn(`⚠️ Error closing ${key}:`, err.message);
              }
            }
            activeConnections.delete(meeting_uuid);
          }
        }
      }
    } catch (err) {
      console.error('❌ Error processing message:', err.message);
    }
  });

  ws.on('error', (err) => {
    console.error(`⚠️ WebSocket Error: ${err.message}`);
  });

  ws.on('close', (code, reason) => {
    console.warn(`🔌 WebSocket closed | Code: ${code}, Reason: ${reason}`);
  });

}

// Start HTTP server and attach frontend WebSocket
const server = http.createServer(app);
setupFrontendWss(server); // initialize frontend WebSocket on /ws

server.listen(port, () => {
  console.log(`🚀 Server running at http://localhost:${port}`);
  console.log(`📩 Webhook available at http://localhost:${port}${config.webhookPath}`);
  console.log(`🌐 Frontend WebSocket available at ws://localhost:${port}/ws`);

  // Optional Zoom S2S test call
  // (async () => {
  //   try {
  //     const users = await s2sZoomApiRequest({
  //       url: 'https://api.zoom.us/v2/users',
  //       method: 'GET'
  //     });
  //     console.log('✅ Zoom S2S API connected. Users:', users?.users?.length || 'N/A');
  //   } catch (err) {
  //     console.error('❌ Zoom S2S error:', err.message);
  //   }
  // })();

  
});
