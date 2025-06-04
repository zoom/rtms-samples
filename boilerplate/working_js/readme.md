# Zoom RTMS Media Receiver (Node.js)

This Node.js example demonstrates how to receive real-time audio, video, screen share, transcript, and chat data from a Zoom meeting using the RTMS (Real-Time Media Streaming) service.
The server connects to Zoom’s RTMS infrastructure via WebSocket, handles webhook events, and saves media streams like JPEG frames, PNGs, and H.264 data locally.

## Prerequisites

- Node.js v14 or higher
- A Zoom account with RTMS enabled
- Zoom App credentials (Client ID and Client Secret)
- Zoom Secret Token for webhook validation

## Setup

1. Install dependencies:
```bash
npm install
```

2. Create a `.env` file in the root directory with the following content:
```
ZOOM_SECRET_TOKEN=your_secret_token
ZM_CLIENT_ID=your_client_id
ZM_CLIENT_SECRET=your_client_secret
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

3. Set your Zoom App's Event Notification URL to point to your ngrok endpoint, e.g.:
```
https://<your-ngrok-subdomain>.ngrok.io/webhook
```

4. Start a Zoom meeting and initiate RTMS streaming.

## How it Works

1. The server listens for RTMS webhook events from Zoom (`/webhook` endpoint).
2. On receiving a `meeting.rtms_started` event, it connects to Zoom's signaling server via WebSocket.
3. Upon successful handshake, it connects to the media WebSocket server.
4. The server listens for and processes incoming media messages:
   - **msg_type 14**: Audio
   - **msg_type 15**: Video
   - **msg_type 16**: Screen Share (Image/Video formats)
   - **msg_type 17**: Transcript
   - **msg_type 18**: Chat
5. Screen-share Data is parsed and saved locally to the `recordings/` directory exclusively either as:
   - JPEGs and PNGs are saved as separate files
   - H.264 video chunks are appended to a single file per user
   Note: Small or invalid frames are ignored

## index.html (Zoom App Context Viewer)

The `public/index.html` file is a lightweight frontend page intended to be used within a Zoom App. It uses the Zoom App SDK to retrieve and display contextual information about the current Zoom session.

### Key Features:

- Loads and initializes the Zoom SDK
- Retrieves contextual information using the following capabilities:
  - `getSupportedJsApis`
  - `getRunningContext`
  - `getMeetingContext`
  - `getUserContext`
  - `getMeetingUUID`
  - `getAppContext`
- Displays this information in a formatted and readable way
- Includes a canvas area for optional visual output (placeholder)

### Usage:

This page is served at the root (`/`) of the server and can be accessed via:
```
http://localhost:3000/
```

You can also integrate it into your Zoom App via an iframe, as long as `https://appssdk.zoom.us/sdk.js` is properly whitelisted in your app's "Domain Allow List" on the Zoom App Marketplace.

## Notes

- This example focuses on processing RTMS events and saving data based on message types.
- Handshakes and keep-alive messages are handled automatically for both signaling and media connections.
- Ensure your Zoom App is configured to send the appropriate webhook events.
- RTMS must be enabled for your Zoom account and meeting.

## Example Directory Structure

```
.
├── index.js
├── public/
│   └── index.html
├── recordings/
│   ├── user123_1623456789012.jpg
│   └── user456.h264
├── .env
└── package.json
```

## Security

- The `.env` file must be kept secret. Never commit it to version control.
- Consider using HTTPS in production and validating Zoom webhook signatures for enhanced security.
