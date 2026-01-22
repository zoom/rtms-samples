# Zoom RTMS Transcription Generation Project

This project demonstrate transcription generation using the Zoom RTMS (Realtime Media Service). It focuses on capturing transcript data and generating VTT (Web Video Text Tracks), SRT (SubRip Subtitle), and plain text transcripts from Zoom meetings using the shared `RTMSManager` and `WebhookManager` libraries.

## Prerequisites

Before running the application, ensure you have the following environment variables set in a `.env` file:
- `ZOOM_SECRET_TOKEN`: Secret token for URL validation
- `ZOOM_CLIENT_ID`: Zoom client ID
- `ZOOM_CLIENT_SECRET`: Zoom client secret

### Additional Environment Variables:
- `PORT`: The port on which the Express server runs (default: 3000)
- `WEBHOOK_PATH`: The path for the webhook endpoint (default: `/webhook`)

## Implementation Details

The application uses a modular approach with shared libraries:

1. **RTMSManager**: Handles the complexity of RTMS connection management, authentication, and data parsing.
2. **WebhookManager**: Manages Zoom webhook events and URL validation.

The application follows this sequence:

1. Initializes `RTMSManager` with Zoom credentials.
2. Starts an Express server and sets up `WebhookManager` to listen for Zoom events.
3. When a meeting starts:
   - `WebhookManager` receives the `meeting.rtms_started` event.
   - `RTMSManager` automatically establishes the necessary connections.
4. During the meeting:  
   - `RTMSManager` emits `transcript` events containing parsed transcript data.
   - The application captures this data and saves it in VTT, SRT, and TXT formats.
5. When a meeting ends: 
   - `WebhookManager` receives the `meeting.rtms_stopped` event.
   - `RTMSManager` gracefully closes all active connections.

## Transcript Data Payload

The `transcript` event provides a rich payload:

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
   - Automatically manage WebSocket connections via `RTMSManager`
   - Capture and save transcript data to `recordings/{meetingId}/`

## Project-Specific Features  

- Realtime transcript data capture using `RTMSManager`
- Automatic WebSocket connection and handshake management
- Multi-format transcript generation (VTT, SRT, TXT)
- Accurate timing using `startTime` and `endTime` (ms) for VTT/SRT
- Absolute time tracking using `timestamp` (converted from microseconds) for TXT
- MeetingUuid based folder creation and unique filenames
- URL validation handling via `WebhookManager`

## Project-Specific Notes  

- The application processes and saves transcript data utilizing absolute timestamp and relative timestamp 
- Server runs on port 3000 by default, if PORT is not specificed in .env
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
