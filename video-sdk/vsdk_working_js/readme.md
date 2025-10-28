# Zoom Video SDK Sample (Node.js)

This Node.js example demonstrates how to receive real-time audio, video, screen share, transcript, and chat data from a Zoom session using the Video SDK service.
The nodejs server side code connects to Zoom's Video SDK infrastructure via WebSocket, handles webhook events

## Prerequisites

- Node.js v18 or higher
- Zoom Video SDK credentials (SDK Key and Secret)

## Setup

1. Install dependencies:
```bash
npm install
```

2. Create a `.env` file in the root directory with the following content:
Refer to .env.example for reference
```
ZOOM_SECRET_TOKEN=your_secret_token
ZOOM_CLIENT_ID=your_client_id
ZOOM_CLIENT_SECRET=your_client_secret
PORT=3000
WEBHOOK_PATH=/webhook
```

## Running the Example

1. Start the server:
```bash
node index.js
```

2. Expose your local server using a tool like ngrok:
```bash
ngrok http 3000
```

3. Set your Video SDK app's webhook URL to point to your ngrok endpoint, e.g.:
```
https://<your-ngrok-subdomain>.ngrok.io/webhook
```

4. Start a Video SDK session and begin streaming.

## Folder Structure

```
.
├── index.js                  # Main entry point that handles webhook events, WebSocket connections, and media processing
├── .env                      # Secrets and config variables (not committed)
├── .env.example              # Template for environment variables
├── package.json              # Dependencies and scripts
├── package-lock.json         # Dependency lock file
├── .gitignore                # Git ignore rules
├── logs/                     # Folder for log files
├── node_modules/             # Dependencies (not committed)
└── recordings/               # Folder to store media files (auto-created)
```

## Architecture

This sample is implemented as a single `index.js` file that contains all the functionality:

1. **Environment Configuration** - Loads settings from .env file
2. **HTTP Server** - Express server handling webhook endpoints
3. **WebSocket Management** - Handles signaling and media connections to Zoom
4. **Media Processing** - Processes incoming audio, video, and transcript data

**System Communication**

        ┌──────────────┐
        │  Zoom SDK    │ ─────► HTTP Webhooks
        └──────────────┘           (session events)
              │
              ▼
        ┌──────────────┐
        │  index.js    │◄────────── WebSocket connections
        └──────────────┘       (signaling + media streams)
              │
              ▼
        ┌──────────────┐
        │ Client Apps  │ ◄───────── Real-time data
        └──────────────┘       (processed media streams)



## Notes

- This example focuses on processing Video SDK events and saving data based on message types.
- Handshakes and keep-alive messages are handled automatically for both signaling and media connections.
- Ensure your Video SDK app is configured to send the appropriate webhook events.
- Video SDK must be enabled for your account.



## How it Works

1. The server listens for Video SDK webhook events from Zoom (`/webhook` endpoint).
2. On receiving a `session.sdk_started` event, it connects to Zoom's signaling server via WebSocket.
3. Upon successful handshake, it connects to the media WebSocket server.
4. The server listens for and processes incoming media messages 
   - **msg_type 14**: Audio
   - **msg_type 15**: Video
   - **msg_type 16**: Screen Share (Image/Video formats)
   - **msg_type 17**: Transcript
   - **msg_type 18**: Chat

