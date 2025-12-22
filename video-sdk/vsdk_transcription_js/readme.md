# Zoom Video SDK Local Transcription Sample (Node.js / Bun)

This Node.js example demonstrates how to receive real-time audio data from a Zoom session using the Video SDK service and transcribe it with whisper.cpp. The transcribed text is saved to a file and printed to the console.

## Prerequisites

- Bun 
- Zoom Video SDK credentials (SDK Key and Secret)

## Setup

1. Install dependencies:
```bash
bun install
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
bun index.ts
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
├── index.ts                  # Main entry point that handles webhook events, WebSocket connections, and media processing
├── src
│   ├── config.ts             # Loads configuration and environment variables
│   ├── types.ts              # TypeScript type definitions for the app
│   ├── handlers
│   │   └── media.ts          # Handles incoming media (audio) streams and processing
│   ├── utils
│   │   ├── audio.ts          # Audio utility functions for decoding and formatting
│   │   └── rtms.ts           # RTMS (Real-Time Media Streams) protocol helpers
│   └── websocket
│       ├── media.ts          # Functions for managing Zoom media WebSocket communication
│       └── signaling.ts      # Handles signaling WebSocket to manage session state and events
└── transcript.txt            # Output transcript file for storing transcribed audio
├── .env.example              # Template for environment variables
├── package.json              # Dependencies and scripts
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
        │  index.ts    │◄────────── Entry point
        └──────────────┘       (signaling + media streams)
              │
              ▼
        ┌──────────────┐
        │  websocket   │◄────────── WebSocket connections
        └──────────────┘       (signaling + media streams)
              │
              ▼
   ┌───────────────────────┐
   │  handlers/media.ts    │◄────────── Media message handler
   └───────────────────────┘       (signaling + media streams)
              │
              ▼
     ┌───────────────────┐
     │  utils/audio.ts   │◄────────── Audio Data 
     └───────────────────┘       (processed media streams)
              │
              ▼
      ┌────────────────┐
      │  whisper.cpp   │◄────────── Wave File 
      └────────────────┘       (signaling + media streams)
              │
              ▼
       ┌─────────────────┐
       │ transcript.txt  │ ◄───────── Transcribed data
       └─────────────────┘       (processed media streams)



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
5. The audio data is converted to a wave file and transcribed using whisper.cpp.
6. The transcribed data is saved to a file and printed to the console.