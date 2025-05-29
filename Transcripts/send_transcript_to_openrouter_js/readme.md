# Zoom RTMS Transcription Generation Project

This project demonstrate transcription generation using the Zoom RTMS (Real-Time Meeting Service). It focuses on capturing transcript data and generating VTT (Web Video Text Tracks), SRT (SubRip Subtitle), and plain text transcripts from Zoom meetings.

## Prerequisites

Before running the application, ensure you have the following environment variables set in a `.env` file:
- `ZOOM_SECRET_TOKEN`: Secret token for URL validation
- `ZM_CLIENT_ID`: Zoom client ID
- `ZM_CLIENT_SECRET`: Zoom client secret


### Additional Environment Variables:
- `PORT`: The port on which the Express server runs (default: 3000)
- `OPENAI_API_KEY`: your openai apikey
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
   - Receives transcript data, and send transcript in cleartext to OpenAI assistant API
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
   - Append the transcript data to popular format such as vtt, srt and txt


## Project-Specific Features  

- Real-time transcript data capture
- WebSocket connection management for both signaling and media servers
- MeetingUuid based folder creation and unique filenames
- Keep-alive message handling
- Error handling for WebSocket connections
- URL validation handling

## Project-Specific Notes  

- The application processes and send transcript in cleartext to OpenAI assistant API
- Server runs on port 3000 by default, if PORT is not specificed in .env
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


