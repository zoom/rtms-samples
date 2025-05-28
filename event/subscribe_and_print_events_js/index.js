import express from 'express';
import crypto from 'crypto';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';


// Load environment variables from a .env file
dotenv.config();

const app = express();
const port = process.env.PORT || 3000;
const execAsync = promisify(exec);

const ZOOM_SECRET_TOKEN = process.env.ZOOM_SECRET_TOKEN;
const CLIENT_ID = process.env.ZM_CLIENT_ID;
const CLIENT_SECRET = process.env.ZM_CLIENT_SECRET;
const WEBHOOK_PATH = process.env.WEBHOOK_PATH || '/webhook';


// Middleware to parse JSON bodies in incoming requests
app.use(express.json());

// Map to keep track of active WebSocket connections and audio chunks
const activeConnections = new Map();


// Handle POST requests to the webhook endpoint
app.post(WEBHOOK_PATH, (req, res) => {
  console.log('RTMS Webhook received:', JSON.stringify(req.body, null, 2));
  const { event, payload } = req.body;

  // Handle URL validation event
  if (event === 'endpoint.url_validation' && payload?.plainToken) {
    // Generate a hash for URL validation using the plainToken and a secret token
    const hash = crypto
      .createHmac('sha256', ZOOM_SECRET_TOKEN)
      .update(payload.plainToken)
      .digest('hex');
    console.log('Responding to URL validation challenge');
    return res.json({
      plainToken: payload.plainToken,
      encryptedToken: hash,
    });
  }

  // Handle RTMS started event
  if (event === 'meeting.rtms_started') {
    console.log('RTMS Started event received');
    const { meeting_uuid, rtms_stream_id, server_urls } = payload;
    // Initiate connection to the signaling WebSocket server
    connectToSignalingWebSocket(meeting_uuid, rtms_stream_id, server_urls);
  }

  // Handle RTMS stopped event
  if (event === 'meeting.rtms_stopped') {
    console.log('RTMS Stopped event received');
    const { meeting_uuid } = payload;

    // Close all active WebSocket connections for the given meeting UUID
    if (activeConnections.has(meeting_uuid)) {
      const connections = activeConnections.get(meeting_uuid);
      for (const conn of Object.values(connections)) {
        if (conn && typeof conn.close === 'function') {
          conn.close();
        }
      }
      activeConnections.delete(meeting_uuid);
    }
  }

  // Respond with HTTP 200 status
  res.sendStatus(200);
});

// Function to generate a signature for authentication
function generateSignature(CLIENT_ID, meetingUuid, streamId, CLIENT_SECRET) {
  console.log('Generating signature with parameters:');
  console.log('meetingUuid:', meetingUuid);
  console.log('streamId:', streamId);

  // Create a message string and generate an HMAC SHA256 signature
  const message = `${CLIENT_ID},${meetingUuid},${streamId}`;
  return crypto.createHmac('sha256', CLIENT_SECRET).update(message).digest('hex');
}

// Function to connect to the signaling WebSocket server
function connectToSignalingWebSocket(meetingUuid, streamId, serverUrl) {
  console.log(`Connecting to signaling WebSocket for meeting ${meetingUuid}`);

  const ws = new WebSocket(serverUrl);

  // Store connection for cleanup later
  if (!activeConnections.has(meetingUuid)) {
    activeConnections.set(meetingUuid, {});
  }
  activeConnections.get(meetingUuid).signaling = ws;

  ws.on('open', () => {
    console.log(`Signaling WebSocket connection opened for meeting ${meetingUuid}`);
    const signature = generateSignature(
      CLIENT_ID,
      meetingUuid,
      streamId,
      CLIENT_SECRET
    );

    // Send handshake message to the signaling server
    const handshake = {
      msg_type: 1, // SIGNALING_HAND_SHAKE_REQ
      protocol_version: 1,
      meeting_uuid: meetingUuid,
      rtms_stream_id: streamId,
      sequence: Math.floor(Math.random() * 1e9),
      signature,
    };
    ws.send(JSON.stringify(handshake));
    console.log('Sent handshake to signaling server');
  });

  ws.on('message', (data) => {
    const msg = JSON.parse(data);
    console.log('Signaling Message:', JSON.stringify(msg, null, 2));

    // Handle successful handshake response
    if (msg.msg_type === 2 && msg.status_code === 0) { // SIGNALING_HAND_SHAKE_RESP
      const mediaUrl = msg.media_server?.server_urls?.all;
      if (mediaUrl) {
        // Connect to the media WebSocket server using the media URL
        connectToMediaWebSocket(mediaUrl, meetingUuid, streamId, ws);
      }

      //subscribe to events 
      const payload = {
        msg_type: 5,
        events: [
          { event_type: 2, subscribe: true },
          { event_type: 3, subscribe: true },
          { event_type: 4, subscribe: true }
        ]
      };
      ws.send(JSON.stringify(payload));
      console.log('[SUCCESS] Event Subscription Payload sent:', JSON.stringify(payload, null, 2));
    }

    if (msg.msg_type === 6) {
      console.log("Event Subscription Received.");

      switch (msg.event.event_type) {
        case 1:
          console.log("Event: First packet capture timestamp received.");
          break;
        case 2:
          console.log("Event: Active speaker has changed.");
          break;
        case 3:
          console.log("Event: Participant joined.");
          break;
        case 4:
          console.log("Event: Participant left.");
          break;
        default:
          console.log("Event: Unknown event type.");
      }
    }

    if (msg.msg_type === 8) {
      console.log("Stream Update Received.");

      switch (msg.state) {
        case 0:
          console.log("Stream State: Inactive.");
          break;
        case 1:
          console.log("Stream State: Active.");
          break;
        case 2:
          console.log("Stream State: Interrupted.");
          break;
        case 3:
        case 4:
          console.log("Stream State: Terminating.");
          break;
        default:
          console.log("Stream State: Unknown state.");
      }

      switch (msg.stop_reason) {
        case 1:
          console.log("Stopped because the host triggered it.");
          break;
        case 2:
          console.log("Stopped because the user triggered it.");
          break;
        case 3:
          console.log("Stopped because the user left.");
          break;
        case 4:
          console.log("Stopped because the user was ejected.");
          break;
        case 5:
          console.log("Stopped because the app was disabled by the host.");
          break;
        case 6:
          console.log("Stopped because the meeting ended.");
          break;
        case 7:
          console.log("Stopped because the stream was canceled.");
          break;
        case 8:
          console.log("Stopped because the stream was revoked.");
          break;
        case 9:
          console.log("Stopped because all apps were disabled.");
          break;
        case 10:
          console.log("Stopped due to an internal exception.");
          break;
        case 11:
          console.log("Stopped because the connection timed out.");
          break;
        case 12:
          console.log("Stopped due to meeting connection interruption.");
          break;
        case 13:
          console.log("Stopped because the signaling connection was interrupted.");
          break;
        case 14:
          console.log("Stopped because the data connection was interrupted.");
          break;
        case 15:
          console.log("Stopped because the signaling connection closed abnormally.");
          break;
        case 16:
          console.log("Stopped because the data connection closed abnormally.");
          break;
        case 17:
          console.log("Stopped due to receiving an exit signal.");
          break;
        case 18:
          console.log("Stopped due to an authentication failure.");
          break;
        default:
          console.log("Stopped for an unknown reason.");
      }
    }

    if (msg.msg_type === 9) {
      console.log("Session State Update Received.");

      switch (msg.state) {
        case 2:
          console.log("Session State: Started.");
          break;
        case 3:
          console.log("Session State: Paused.");
          break;
        case 4:
          console.log("Session State: Resumed.");
          break;
        case 5:
          console.log("Session State: Stopped.");
          break;
        default:
          console.log("Session State: Unknown state.");
      }

      switch (msg.stop_reason) {
        case 1:
          console.log("Stopped because the host triggered it.");
          break;
        case 2:
          console.log("Stopped because the user triggered it.");
          break;
        case 3:
          console.log("Stopped because the user left.");
          break;
        case 4:
          console.log("Stopped because the user was ejected.");
          break;
        case 5:
          console.log("Stopped because the app was disabled by the host.");
          break;
        case 6:
          console.log("Stopped because the meeting ended.");
          break;
        case 7:
          console.log("Stopped because the stream was canceled.");
          break;
        case 8:
          console.log("Stopped because the stream was revoked.");
          break;
        case 9:
          console.log("Stopped because all apps were disabled.");
          break;
        case 10:
          console.log("Stopped due to an internal exception.");
          break;
        case 11:
          console.log("Stopped because the connection timed out.");
          break;
        case 12:
          console.log("Stopped due to meeting connection interruption.");
          break;
        case 13:
          console.log("Stopped because the signaling connection was interrupted.");
          break;
        case 14:
          console.log("Stopped because the data connection was interrupted.");
          break;
        case 15:
          console.log("Stopped because the signaling connection closed abnormally.");
          break;
        case 16:
          console.log("Stopped because the data connection closed abnormally.");
          break;
        case 17:
          console.log("Stopped due to receiving an exit signal.");
          break;
        case 18:
          console.log("Stopped due to an authentication failure.");
          break;
        default:
          console.log("Stopped for an unknown reason.");
      }
    }
    // Respond to keep-alive requests
    if (msg.msg_type === 12) { // KEEP_ALIVE_REQ
      const keepAliveResponse = {
        msg_type: 13, // KEEP_ALIVE_RESP
        timestamp: msg.timestamp,
      };
      console.log('Responding to Signaling KEEP_ALIVE_REQ:', keepAliveResponse);
      ws.send(JSON.stringify(keepAliveResponse));
    }
  });

  ws.on('error', (err) => {
    console.error('Signaling socket error:', err);
  });

  ws.on('close', () => {
    console.log('Signaling socket closed');
    if (activeConnections.has(meetingUuid)) {
      delete activeConnections.get(meetingUuid).signaling;
    }
  });
}

// Function to connect to the media WebSocket server
function connectToMediaWebSocket(mediaUrl, meetingUuid, streamId, signalingSocket) {
  console.log(`Connecting to media WebSocket at ${mediaUrl}`);

  const mediaWs = new WebSocket(mediaUrl, { rejectUnauthorized: false });

  // Store connection for cleanup later
  if (activeConnections.has(meetingUuid)) {
    activeConnections.get(meetingUuid).media = mediaWs;
  }



  mediaWs.on('open', () => {
    const signature = generateSignature(
      CLIENT_ID,
      meetingUuid,
      streamId,
      CLIENT_SECRET
    );
    const handshake = {
      msg_type: 3, // DATA_HAND_SHAKE_REQ
      protocol_version: 1,
      meeting_uuid: meetingUuid,
      rtms_stream_id: streamId,
      signature,
      media_type: 32, // AUDIO+VIDEO+TRANSCRIPT
      payload_encryption: false,
      media_params: {
        audio: {
          content_type: 1,
          sample_rate: 1,
          channel: 1,
          codec: 1,
          data_opt: 1,
          send_rate: 100
        },
        video: {
          codec: 7, //H264
          resolution: 2,
          fps: 25
        }
      }
    };
    mediaWs.send(JSON.stringify(handshake));
  });

  mediaWs.on('message', (data) => {
    try {
      // Try to parse as JSON first
      const msg = JSON.parse(data.toString());
      // debugging
      //console.log('Media JSON Message:', JSON.stringify(msg, null, 2));

      // Handle successful media handshake
      if (msg.msg_type === 4 && msg.status_code === 0) { // DATA_HAND_SHAKE_RESP
        signalingSocket.send(
          JSON.stringify({
            msg_type: 7, // CLIENT_READY_ACK
            rtms_stream_id: streamId,
          })
        );
        console.log('Media handshake successful, sent start streaming request');
      }

      // Respond to keep-alive requests
      if (msg.msg_type === 12) { // KEEP_ALIVE_REQ
        mediaWs.send(
          JSON.stringify({
            msg_type: 13, // KEEP_ALIVE_RESP
            timestamp: msg.timestamp,
          })
        );
        console.log('Responded to Media KEEP_ALIVE_REQ');
      }

      // Handle audio data
      if (msg.msg_type === 14 && msg.content && msg.content.data) {

      }
      // Handle video data
      if (msg.msg_type === 15 && msg.content && msg.content.data) {

      }
      // Handle transcript data
      if (msg.msg_type === 17 && msg.content && msg.content.data) {

      }
    } catch (err) {
      console.error('Error processing media message:', err);
    }
  });

  mediaWs.on('error', (err) => {
    console.error('Media socket error:', err);
  });

  mediaWs.on('close', () => {
    console.log('Media socket closed');
    if (activeConnections.has(meetingUuid)) {
      delete activeConnections.get(meetingUuid).media;
    }
  });
}


// Start the server and listen on the specified port
app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
  console.log(`Webhook endpoint available at http://localhost:${port}${WEBHOOK_PATH}`);
});