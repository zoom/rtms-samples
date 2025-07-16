import express from 'express';
import WebSocket from 'ws';
import crypto from 'crypto';
import dotenv from 'dotenv';
import axios from 'axios';

// Load environment variables from .env
dotenv.config();

const app = express();
app.use(express.json()); // Parse incoming JSON payloads

// Step 1: Webhook Receiver - Listen for meeting events
app.post("/webhook", async (req, res) => {
  const { event, payload } = req.body;
  console.log('Webhook received:', event);
  console.log('Payload:', JSON.stringify(payload, null, 2));

  // Step 2a: Listen to meeting started event
  if (event === 'meeting.started') {
    console.log('Meeting started, initiating RTMS...');
    const { object } = payload;
    const meetingId = object.id;
    const meetingUuid = object.uuid;
    
    try {
      // Step 2b: Get access token
      const accessToken = generateAccessToken();
      
      // Step 2c: Make API call to start RTMS
      await startRTMS(meetingId, accessToken);
      
      console.log(`RTMS started for meeting ${meetingId}`);
      
      // Schedule automatic RTMS stop after 60 seconds
      scheduleRTMSStop(meetingId, accessToken);
    } catch (error) {
      console.error('Error starting RTMS:', error);
    }
  }

  // Step 3: RTMS started event
  if (event === 'meeting.rtms_started') {
    console.log('Starting RTMS connection...');
    const { meeting_uuid, rtms_stream_id, server_urls } = payload;
    connectToSignalingWebSocket(meeting_uuid, rtms_stream_id, server_urls);
  }

  // When meeting RTMS stops, log the stop event
  if (event === 'meeting.rtms_stopped') {
    const { meeting_uuid } = payload;
    console.log(`Meeting ${meeting_uuid} stopped`);
    // Open WebSocket connections will close naturally
  }

  res.sendStatus(200); // Acknowledge webhook receipt
});

// Step 4: Generate Signature for authentication handshake
function generateSignature(meetingUuid, streamId) {
  const message = `${process.env.ZOOM_CLIENT_ID},${meetingUuid},${streamId}`;
  return crypto.createHmac('sha256', process.env.ZOOM_CLIENT_SECRET)
    .update(message).digest('hex');
}

// Helper function: Generate access token from environment variable
// Your logic to generate accesstoken will be here. Please visit https://developers.zoom.us/docs/integrations/oauth/ to know more.
function generateAccessToken() {
  const accessToken = process.env.access_token;
  if (!accessToken) {
    throw new Error('access_token not found in environment variables');
  }
  console.log('Using access token from environment variables');
  return accessToken;
}

// Helper function: Manually start RTMS using Zoom API
async function startRTMS(meetingId, accessToken) {
  try {
    const response = await axios.patch(
      `https://api.zoom.us/v2/live_meetings/${meetingId}/rtms_app/status`,
      {
        action: 'start',
        settings: {
          client_id: process.env.ZOOM_CLIENT_ID
        }
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`
        }
      }
    );
    
    console.log('RTMS start response:', response.data);
    return response.data;
  } catch (error) {
    console.error('Error starting RTMS via API:', error.response?.data || error.message);
    throw error;
  }
}

// Step 5: WebSocket 1 - Connect to Signaling WebSocket
function connectToSignalingWebSocket(meetingUuid, streamId, serverUrls) {
  console.log(`Connecting to signaling WebSocket: ${serverUrls}`);
  const signalingWs = new WebSocket(serverUrls);

  // Once signaling WebSocket is open, send handshake
  signalingWs.on('open', () => {
    console.log('Signaling WebSocket opened');
    signalingWs.send(JSON.stringify({
      msg_type: 1, // HANDSHAKE_REQUEST
      meeting_uuid: meetingUuid,
      rtms_stream_id: streamId,
      signature: generateSignature(meetingUuid, streamId)
    }));
  });

  // Handle incoming signaling messages
  signalingWs.on('message', (data) => {
    const msg = JSON.parse(data);
    console.log('Signaling message:', msg);

    // If handshake is successful, proceed to media connection
    if (msg.msg_type === 2 && msg.status_code === 0) {
      const mediaUrl = msg.media_server.server_urls.transcript;
      connectToMediaWebSocket(mediaUrl, meetingUuid, streamId, signalingWs);
    }

    // If keep-alive request is received, respond with ACK
    if (msg.msg_type === 12) {
      signalingWs.send(JSON.stringify({
        msg_type: 13,
        timestamp: msg.timestamp
      }));
    }
  });

  // Log signaling errors
  signalingWs.on('error', (error) => {
    console.error('Signaling WebSocket error:', error);
  });

  // Log signaling WebSocket closure
  signalingWs.on('close', () => {
    console.log('Signaling WebSocket closed');
  });
}

// Step 6: WebSocket 2 - Connect to Media WebSocket
function connectToMediaWebSocket(mediaUrl, meetingUuid, streamId, signalingSocket) {
  console.log(`Connecting to media WebSocket: ${mediaUrl}`);
  const mediaWs = new WebSocket(mediaUrl);

  // Once media WebSocket is open, send media handshake
  mediaWs.on('open', () => {
    console.log('Media WebSocket opened');
    mediaWs.send(JSON.stringify({
      msg_type: 3, // MEDIA_HANDSHAKE_REQUEST
      protocol_version: 1,
      sequence: 0,
      meeting_uuid: meetingUuid,
      rtms_stream_id: streamId,
      signature: generateSignature(meetingUuid, streamId),
      media_type: 8 // Request transcript stream
    }));
  });

  // Handle incoming media messages
  mediaWs.on('message', (data) => {
    const msg = JSON.parse(data);
    console.log('Media message received:', msg);

    // Respond to keep-alive request from media server
    if (msg.msg_type === 12) {
      console.log('Responding to media keep-alive');
      mediaWs.send(JSON.stringify({
        msg_type: 13,
        timestamp: msg.timestamp
      }));
    }

    // If media handshake is successful, notify signaling server that client is ready
    if (msg.msg_type === 4 && msg.status_code === 0) {
      console.log('Media handshake successful, sending CLIENT_READY_ACK');
      signalingSocket.send(JSON.stringify({
        msg_type: 7,
        rtms_stream_id: streamId
      }));
    }

    // Log incoming transcript data
    if (msg.msg_type === 5) {
      console.log('Transcript:', msg);
    }
  });

  // Log media errors
  mediaWs.on('error', (error) => {
    console.error('Media WebSocket error:', error);
  });

  // Log media WebSocket closure
  mediaWs.on('close', () => {
    console.log('Media WebSocket closed');
  });
}


// Step 7: Stop RTMS using Zoom API
async function stopRTMS(meetingId, accessToken) {
  try {
    const response = await axios.patch(
      `https://api.zoom.us/v2/live_meetings/${meetingId}/rtms_app/status`,
      {
        action: 'stop',
        settings: {
          client_id: process.env.ZOOM_CLIENT_ID
        }
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`
        }
      }
    );
    
    console.log('RTMS stop response:', response.data);
    return response.data;
  } catch (error) {
    console.error('Error stopping RTMS via API:', error.response?.data || error.message);
    throw error;
  }
}

// Helper function: Schedule RTMS stop after 10 seconds 
// Your logic to stop RTMS will go here 
function scheduleRTMSStop(meetingId, accessToken) {
  console.log(`Scheduling RTMS stop for meeting ${meetingId} in 60 seconds...`);
  
  setTimeout(async () => {
    try {
      console.log(`Stopping RTMS for meeting ${meetingId}...`);
      await stopRTMS(meetingId, accessToken);
      console.log(`RTMS stopped successfully for meeting ${meetingId}`);
    } catch (error) {
      console.error(`Failed to stop RTMS for meeting ${meetingId}:`, error);
    }
  }, 10000); // 10 seconds
}

// Step 7: Start Express server on port 3000
app.listen(3000, () => console.log('Server running on port 3000'));

