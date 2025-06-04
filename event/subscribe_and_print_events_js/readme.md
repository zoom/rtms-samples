# Zoom RTMS Events Handler

This project listens to Zoom RTMS (Real-Time Media Streaming) webhook events and establishes signaling and media WebSocket connections to process various meeting-related events.

## Prerequisites

Ensure a `.env` file exists with the following variables:

```env
ZOOM_SECRET_TOKEN=your_zoom_secret_token
ZM_CLIENT_ID=your_zoom_client_id
ZM_CLIENT_SECRET=your_zoom_client_secret
PORT=3000 # optional, defaults to 3000
WEBHOOK_PATH=/webhook # optional
```

## Running the Application

```bash
node index.js
```

Make sure your Zoom App is configured with the appropriate RTMS scopes and your server is accessible via public URL (e.g., via ngrok).

## Workflow

1. Express Server Initialization
   - Starts on `PORT` or defaults to `3000`
   - Webhook endpoint available at `/webhook`

2. Webhook Event Handling
   - Handles `endpoint.url_validation` with encrypted response
   - Handles `meeting.rtms_started`
     - Connects to Zoom’s signaling WebSocket server
     - Sends handshake with HMAC SHA256 signature
     - Subscribes to events: speaker changes, participant join/leave
     - Receives media server URL and connects to it
     - Sends media handshake for audio, video, and transcript
   - Handles `meeting.rtms_stopped`
     - Cleans up all WebSocket connections for the meeting

3. WebSocket Management
   - Maintains signaling and media WebSocket connections
   - Responds to `KEEP_ALIVE_REQ` from both connections
   - Handles and logs the following:
     - Stream state updates
     - Session state updates
     - RTMS events: participant joined/left, active speaker changes
     - Media handshake acknowledgments

4. Event Logging
   - Prints all key events and stream/session states to console
   - Includes error handling and graceful socket closure

## Features

- URL validation for Zoom webhook setup
- Authenticated WebSocket handshakes using HMAC SHA256
- Dual WebSocket connections (signaling & media)
- Full event subscription and interpretation
- Detailed console logs for all events, stream, and session updates
- Auto-reply to keep-alive messages
- Cleanup on meeting end (`rtms_stopped`)

## Additional Requirements

- Node.js v14+
- `ngrok` (to expose local server for Zoom Webhook)
- A Zoom App with RTMS capabilities enabled and webhook URL configured

## Troubleshooting

- No webhook events received?
  - Check if ngrok is running and webhook URL is correct
  - Confirm Zoom app scopes and webhook configurations

- Signature mismatch or unauthorized?
  - Ensure `ZOOM_SECRET_TOKEN`, `ZM_CLIENT_ID`, and `ZM_CLIENT_SECRET` are correct in `.env`

- WebSocket issues?
  - Verify internet connection and WebSocket server availability
  - Check logs for handshake status and error events
