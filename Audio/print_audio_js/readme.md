# Audio Processing Project

A Node.js implementation demonstrating Zoom's Real-Time Media Streams (RTMS) for capturing meeting audio data.

## Features

- Real-time audio data capture from Zoom meetings
- Displays raw audio data in hexadecimal format
- Handles WebSocket connections for both signaling and media servers
- Automatic connection cleanup on meeting end
- Built-in URL validation for Zoom webhooks

## Prerequisites

- Node.js (v14 or higher)
- A Zoom account with RTMS enabled
- Environment variables:
  - `ZOOM_SECRET_TOKEN`: For webhook validation
  - `ZM_CLIENT_ID`: Your Zoom client ID
  - `ZM_CLIENT_SECRET`: Your Zoom client secret

## Installation

1. Install dependencies:
```bash
npm install express ws crypto dotenv
```

2. Create a `.env` file with your credentials:
```env
ZOOM_SECRET_TOKEN=your_token
ZM_CLIENT_ID=your_client_id
ZM_CLIENT_SECRET=your_client_secret
```

## How It Works

### 1. Webhook Handling
- Listens for Zoom webhook events on `/webhook` endpoint
- Validates webhook URLs using HMAC SHA-256
- Processes three main events:
  - `endpoint.url_validation`: For webhook setup
  - `meeting.rtms_started`: Initiates WebSocket connections
  - `meeting.rtms_stopped`: Cleans up connections

### 2. WebSocket Connections
- Maintains two WebSocket connections per meeting:
  - Signaling connection: For session management
  - Media connection: For receiving audio data
- Automatically responds to keep-alive messages
- Tracks connections using a Map for easy cleanup

### 3. Audio Data Processing
- Receives raw audio data through media WebSocket
- Displays audio data in hexadecimal format
- Real-time console output

## Usage

1. Start the server:
```bash
node print_audio.js
```

2. Expose your local server (e.g., using ngrok):
```bash
ngrok http 3000
```

3. Configure your Zoom app's webhook URL to point to your exposed endpoint

4. Start a Zoom meeting with RTMS enabled to see the audio data

## Implementation Details

### Connection Management
```javascript
const activeConnections = new Map();
// Structure:
{
    [meetingUuid]: {
        signaling: WebSocket,
        media: WebSocket
    }
}
```

### Message Types
- `SIGNALING_HAND_SHAKE_REQ (1)`: Initial auth
- `SIGNALING_HAND_SHAKE_RESP (2)`: Get media URL
- `DATA_HAND_SHAKE_REQ (3)`: Media auth
- `DATA_HAND_SHAKE_RESP (4)`: Start streaming
- `CLIENT_READY_ACK (7)`: Ready for data
- `KEEP_ALIVE_REQ (12)`: Keep-alive request
- `KEEP_ALIVE_RESP (13)`: Keep-alive response

## Error Handling
- WebSocket connection errors are logged
- Automatic cleanup of closed connections
- Graceful handling of JSON parsing errors
- Proper connection cleanup on meeting end

## Notes
- Server runs on port 3000 by default
- Audio data is displayed in real-time, not stored
- Connections are automatically cleaned up
- Keep-alive messages are handled automatically

## Code Explanation

### Server Setup
```javascript
import express from 'express';
import WebSocket from 'ws';
import crypto from 'crypto';
import dotenv from 'dotenv';

const app = express();
app.use(express.json());

// Load environment variables
dotenv.config();
const ZOOM_SECRET_TOKEN = process.env.ZOOM_SECRET_TOKEN;
```
The server uses Express.js for handling HTTP requests and the `ws` library for WebSocket connections. Environment variables are loaded using `dotenv`.

### Webhook Handler
```javascript
app.post('/webhook', (req, res) => {
    const { event, payload } = req.body;

    // URL Validation
    if (event === 'endpoint.url_validation' && payload?.plainToken) {
        const hash = crypto
            .createHmac('sha256', ZOOM_SECRET_TOKEN)
            .update(payload.plainToken)
            .digest('hex');
        return res.json({
            plainToken: payload.plainToken,
            encryptedToken: hash,
        });
    }

    // RTMS Started
    if (event === 'meeting.rtms_started') {
        const { meeting_uuid, rtms_stream_id, server_urls } = payload;
        connectToSignalingWebSocket(meeting_uuid, rtms_stream_id, server_urls);
    }

    // RTMS Stopped
    if (event === 'meeting.rtms_stopped') {
        const { meeting_uuid } = payload;
        // Close and cleanup connections
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
});
```
The webhook handler processes three main events:
1. `endpoint.url_validation`: Validates the webhook URL using HMAC SHA-256
2. `meeting.rtms_started`: Initiates WebSocket connections when a meeting starts
3. `meeting.rtms_stopped`: Cleans up connections when a meeting ends

### Signaling Connection
```javascript
function connectToSignalingWebSocket(meetingUuid, streamId, serverUrls) {
    const signalingWs = new WebSocket(serverUrls);
    
    // Store connection for later use
    activeConnections.set(meetingUuid, { signaling: signalingWs });

    signalingWs.on('open', () => {
        // Send handshake message
        const signature = generateSignature(meetingUuid, streamId);
        signalingWs.send(JSON.stringify({
            msg_type: 1, // SIGNALING_HAND_SHAKE_REQ
            meeting_uuid: meetingUuid,
            rtms_stream_id: streamId,
            signature: signature
        }));
    });

    signalingWs.on('message', (data) => {
        const msg = JSON.parse(data);
        if (msg.msg_type === 2 && msg.status_code === 0) {
            // Connect to media server on successful handshake
            const mediaUrl = msg.media_server.server_urls.all;
            connectToMediaWebSocket(mediaUrl, meetingUuid, streamId, signalingWs);
        }
    });
}
```
The signaling connection:
1. Establishes initial connection with Zoom's signaling server
2. Sends authentication handshake
3. Receives media server URL
4. Initiates media server connection

### Media Connection
```javascript
function connectToMediaWebSocket(mediaUrl, meetingUuid, streamId, signalingSocket) {
    const mediaWs = new WebSocket(mediaUrl);
    
    // Store media connection
    activeConnections.get(meetingUuid).media = mediaWs;

    mediaWs.on('message', (data) => {
        try {
            // Try to parse as JSON first (for control messages)
            const msg = JSON.parse(data.toString());
            
            // Handle handshake response
            if (msg.msg_type === 4 && msg.status_code === 0) {
                signalingSocket.send(JSON.stringify({
                    msg_type: 7, // CLIENT_READY_ACK
                    rtms_stream_id: streamId,
                }));
            }

            // Handle keep-alive
            if (msg.msg_type === 12) {
                mediaWs.send(JSON.stringify({
                    msg_type: 13,
                    timestamp: msg.timestamp,
                }));
            }
        } catch (err) {
            // If JSON parsing fails, it's binary audio data
            console.log('Raw audio data (hex):', data.toString('hex'));
        }
    });
}
```
The media connection:
1. Connects to Zoom's media server
2. Handles control messages (handshake, keep-alive)
3. Processes incoming audio data
4. Displays audio data in hexadecimal format

### Helper Functions
```javascript
function generateSignature(meetingUuid, streamId) {
    const message = `${process.env.ZM_CLIENT_ID},${meetingUuid},${streamId}`;
    return crypto
        .createHmac('sha256', process.env.ZM_CLIENT_SECRET)
        .update(message)
        .digest('hex');
}
```
Helper functions include:
- `generateSignature`: Creates HMAC SHA-256 signature for authentication
- Connection tracking using `activeConnections` Map
- Error handling and cleanup functions

### Data Flow
1. Zoom sends webhook event when meeting starts
2. Server establishes signaling connection
3. After successful signaling handshake, connects to media server
4. Media server sends audio data as binary WebSocket messages
5. Server displays audio data in hex format
6. On meeting end, all connections are cleaned up

## Message Flow Sequence

### 1. Initial Connection Sequence
```javascript
// 1. Webhook receives meeting.rtms_started
{
    event: "meeting.rtms_started",
    payload: {
        meeting_uuid: "uuid",
        rtms_stream_id: "stream_id",
        server_urls: "wss://..."
    }
}

// 2. Signaling Handshake Request (msg_type: 1)
{
    msg_type: 1,  // SIGNALING_HAND_SHAKE_REQ
    meeting_uuid: "uuid",
    rtms_stream_id: "stream_id",
    signature: "hmac_signature"
}

// 3. Signaling Handshake Response (msg_type: 2)
{
    msg_type: 2,  // SIGNALING_HAND_SHAKE_RESP
    status_code: 0,
    media_server: {
        server_urls: {
            all: "wss://media-server"
        }
    }
}

// 4. Media Handshake Request (msg_type: 3)
{
    msg_type: 3,  // DATA_HAND_SHAKE_REQ
    meeting_uuid: "uuid",
    rtms_stream_id: "stream_id",
    signature: "hmac_signature"
}

// 5. Media Handshake Response (msg_type: 4)
{
    msg_type: 4,  // DATA_HAND_SHAKE_RESP
    status_code: 0
}

// 6. Client Ready Acknowledgment (msg_type: 7)
{
    msg_type: 7,  // CLIENT_READY_ACK
    rtms_stream_id: "stream_id"
}
```

### 2. Keep-Alive Sequence
```javascript
// 1. Server Keep-Alive Request (msg_type: 12)
{
    msg_type: 12,  // KEEP_ALIVE_REQ
    timestamp: 1234567890
}

// 2. Client Keep-Alive Response (msg_type: 13)
{
    msg_type: 13,  // KEEP_ALIVE_RESP
    timestamp: 1234567890  // Echo server's timestamp
}
```

### Detailed Implementation

#### Client Ready Acknowledgment
```javascript
mediaWs.on('message', (data) => {
    try {
        const msg = JSON.parse(data.toString());
        
        // After successful media handshake, send CLIENT_READY_ACK
        if (msg.msg_type === 4 && msg.status_code === 0) {
            signalingSocket.send(JSON.stringify({
                msg_type: 7,  // CLIENT_READY_ACK
                rtms_stream_id: streamId,
            }));
            console.log('Media handshake successful, sent CLIENT_READY_ACK');
        }
    } catch (err) {
        // Binary audio data handling
    }
});
```
The `CLIENT_READY_ACK` is crucial because:
- It signals that the client is ready to receive audio data
- It completes the handshake sequence
- The server won't send audio data until receiving this acknowledgment

#### Connection State Management
```javascript
const activeConnections = new Map();

// Structure for tracking connection states
{
    [meetingUuid]: {
        signaling: {
            socket: WebSocket,
            state: 'connecting' | 'authenticated' | 'ready',
            lastKeepAlive: timestamp
        },
        media: {
            socket: WebSocket,
            state: 'connecting' | 'authenticated' | 'streaming',
            lastKeepAlive: timestamp
        }
    }
}
```

### Message Type Constants
```javascript
const MessageTypes = {
    SIGNALING_HAND_SHAKE_REQ: 1,
    SIGNALING_HAND_SHAKE_RESP: 2,
    DATA_HAND_SHAKE_REQ: 3,
    DATA_HAND_SHAKE_RESP: 4,
    CLIENT_READY_ACK: 7,
    KEEP_ALIVE_REQ: 12,
    KEEP_ALIVE_RESP: 13
};
```

### Connection Lifecycle
1. **Initialization**
   - Receive webhook with server URLs
   - Establish signaling connection
   - Authenticate with signature

2. **Signaling Phase**
   - Send signaling handshake
   - Receive media server URL
   - Maintain keep-alive

3. **Media Phase**
   - Connect to media server
   - Send media handshake
   - Send CLIENT_READY_ACK
   - Begin receiving audio data

4. **Maintenance**
   - Handle keep-alive messages (every 15s)
   - Monitor connection states
   - Reconnect if needed

5. **Termination**
   - Receive meeting.rtms_stopped
   - Close all connections
   - Clean up resources

### Error Handling and Recovery
```javascript
mediaWs.on('error', (err) => {
    console.error('Media socket error:', err);
    // Mark connection for potential reconnect
    if (activeConnections.has(meetingUuid)) {
        const connection = activeConnections.get(meetingUuid);
        connection.media.state = 'error';
        connection.media.lastError = err;
    }
});

mediaWs.on('close', () => {
    console.log('Media socket closed');
    // Clean up or attempt reconnect based on meeting state
    if (activeConnections.has(meetingUuid)) {
        const connection = activeConnections.get(meetingUuid);
        if (connection.signaling.state === 'ready') {
            // Attempt to reconnect media socket
            connectToMediaWebSocket(mediaUrl, meetingUuid, streamId, connection.signaling.socket);
        } else {
            delete connection.media;
        }
    }
});
```
