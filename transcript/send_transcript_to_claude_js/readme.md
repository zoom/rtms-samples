# Zoom RTMS Transcription Generation with Claude

This project captures realtime transcription data from Zoom meetings via the RTMS (Realtime Meeting Service) and forwards each transcript segment to the Claude Sonnet language model (via API) for processing. It uses the shared `RTMSManager` and `WebhookManager` for robust connection and event management.

## Prerequisites

Before running the application, ensure you have the following environment variables set in a `.env` file:
- `ZOOM_SECRET_TOKEN`: Secret token for URL validation
- `ZOOM_CLIENT_ID`: Zoom client ID
- `ZOOM_CLIENT_SECRET`: Zoom client secret
- `ANTHROPIC_API_KEY`: Your Anthropic / Claude API key

### Additional Environment Variables:
- `PORT`: The port on which the Express server runs (default: 3000)
- `WEBHOOK_PATH`: The path for the webhook endpoint (default: `/webhook`)

## Implementation Details

The application uses shared library components to handle low-level RTMS details:

1. **RTMSManager**: Abstracts WebSocket connection management, authentication, and transcript parsing.
2. **WebhookManager**: Handles Zoom webhook validation and event distribution.

The application follows this sequence:

1. Initializes `RTMSManager` and `WebhookManager`.
2. Starts an Express server and begins listening for webhooks.
3. When a meeting starts:
   - `WebhookManager` receives the `meeting.rtms_started` event.
   - `RTMSManager` automatically establishes signaling and media connections.
4. During the meeting:
   - `RTMSManager` emits `transcript` events.
   - The application receives the transcript data and sends the text to the Claude Sonnet API.
   - Claude's response is logged to the console.
5. When a meeting ends:
   - `WebhookManager` receives the `meeting.rtms_stopped` event.
   - `RTMSManager` closes all active connections.

## Transcript Data Payload

The `transcript` event provides the following fields:

- `text`: The transcript text content
- `userId`: Speaker's user ID
- `userName`: Speaker's name
- `timestamp`: Event timestamp (microseconds)
- `meetingId`: Unique meeting UUID
- `streamId`: RTMS stream ID
- `productType`: "meeting" or "session"
- `startTime`: Utterance start time (milliseconds)
- `endTime`: Utterance end time (milliseconds)
- `language`: Language ID
- `attribute`: Transcript attribute

## Running the Application

1. Start the server:
   ```bash
   node index.js
   ```

2. Start a Zoom meeting. The application will:
   - Receive the `meeting.rtms_started` event
   - Automatically manage connections via `RTMSManager`
   - Capture transcript data and forward it to Claude

## Project-Specific Features

- Realtime transcript data capture using `RTMSManager`
- Automatic connection and handshake management
- Integration with Anthropic Claude for intelligent dialogue analysis
- URL validation handling via `WebhookManager`

## Project-Specific Notes

- The application processes and sends transcript in cleartext to Claude Sonnet API
- Server runs on port 3000 by default, if `PORT` is not specified in `.env`
- Webhook endpoint is available at `http://localhost:3000/webhook`

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
