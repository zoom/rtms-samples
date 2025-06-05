# Zoom RTMS Transcription Generation Project

This project captures real-time transcription data from Zoom meetings via the RTMS (Real-Time Meeting Service) and forwards each transcript segment to the Claude Sonnet language model (via API) for processing. It maintains WebSocket connections with Zoom servers, extracts transcript data in real-time, and enables intelligent processing of meeting conversations using Anthropic’s Claude.

## Prerequisites

Before running the application, ensure you have the following environment variables set in a `.env` file:
- `ZOOM_SECRET_TOKEN`: Secret token for URL validation
- `ZM_CLIENT_ID`: Zoom client ID
- `ZM_CLIENT_SECRET`: Zoom client secret

### Additional Environment Variables:
- `PORT`: The port on which the Express server runs (default: 3000)
- `ANTHROPIC_API_KEY`: your ANTHROPIC / Claude API key

## Implementation Details

The application follows this sequence:

1. Starts an Express server on port 3000
2. Listens for webhook events at `/webhook` endpoint
3. Handles URL validation challenges from Zoom
4. When a meeting starts:
   - Receives `meeting.rtms_started` event
   - Establishes WebSocket connection to signaling server
   - Sends handshake with authentication signature
   - Receives media server URL from signaling server
   - Establishes WebSocket connection to media server
   - Sends media handshake with authentication
   - Begins receiving transcript data
5. During the meeting:
   - Maintains WebSocket connections with keep-alive messages
   - Receives transcript data and sends it in cleartext to Claude Sonnet API
   - Handles any connection errors
6. When a meeting ends:
   - Receives `meeting.rtms_stopped` event
   - Closes all active WebSocket connections

## Running the Application

1. Start the server:
   ```bash
   node index.js
   ```

2. Start a Zoom meeting. The application will:
   - Receive the `meeting.rtms_started` event
   - Establish WebSocket connections
   - Begin capturing transcript data
   - Append the transcript data to formats such as VTT, SRT, and TXT

## Project-Specific Features

- Real-time transcript data capture
- WebSocket connection management for both signaling and media servers
- Meeting UUID-based folder creation and unique filenames
- Keep-alive message handling
- Error handling for WebSocket connections
- URL validation handling

## Project-Specific Notes

- The application processes and sends transcript in cleartext to Claude Sonnet API
- Server runs on port 3000 by default, if `PORT` is not specified in `.env`
- Webhook endpoint is available at `http://localhost:3000/webhook`
- Requires FFmpeg to be installed and accessible in your PATH

## Additional Setup Requirements

1. **Node.js** (v14 or higher recommended)
2. **ngrok** for exposing your local server to the internet
3. **Zoom App** configuration with RTMS scopes enabled

## Troubleshooting

1. **No Transcript Files Generated**:
   - Verify recordings folder is present in your root folder
   - Check that the Zoom app has the correct RTMS scopes
   - Ensure the webhook URL is correctly configured in the Zoom app

2. **Connection Issues**:
   - Verify ngrok is running and the tunnel is active
   - Check that the Zoom app credentials in `.env` are correct
   - Ensure the webhook endpoint is accessible from the internet

## chatWithClaude.js Module Context

The `chatWithClaude.js` module encapsulates the logic for communicating with the Claude Sonnet API from Anthropic. It performs the following key roles in the project:

- Maintains a simple internal history of messages exchanged with Claude to support context-aware interactions.
- Sends each incoming transcript message to Claude as a new user message.
- Awaits Claude's response and logs it, allowing intelligent processing or summarization of real-time meeting dialogue.
- Requires an `ANTHROPIC_API_KEY` environment variable for authorization.
- Uses Axios to handle HTTP requests to the Anthropic API endpoint.

This module is invoked during transcript message processing in the media WebSocket handler of the main Express app, ensuring that live meeting transcriptions are analyzed or summarized by Claude in real-time.
