# Audio to WAV Conversion Project

This project demonstrates real-time audio capture and conversion using the Zoom RTMS . It focuses on capturing audio data from Zoom meetings and converting it to WAV format.

## Prerequisites

Before running the application, ensure you have the following environment variables set in a `.env` file:
- `ZOOM_SECRET_TOKEN`: Secret token for URL validation
- `ZM_CLIENT_ID`: Zoom client ID
- `ZM_CLIENT_SECRET`: Zoom client secret
- `PORT`: default is 3000
 - `WEBHOOK_PATH`: default is /webhook
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
   - Begins receiving audio data
5. During the meeting:
   - Maintains WebSocket connections with keep-alive messages
   - Receives and stores raw audio data chunks
   - Handles any connection errors
6. When a meeting ends:
   - Receives `meeting.rtms_stopped` event
   - Combines all audio chunks into a single buffer
   - Converts raw audio data to WAV format using FFmpeg
   - Saves the WAV file with meeting ID in the filename
   - Cleans up temporary raw audio files
   - Closes all active WebSocket connections

## Running the Application

1. Start the server:
   ```bash
   node save_audio.js
   ```

2. Start a Zoom meeting. The application will:
   - Receive the `meeting.rtms_started` event
   - Establish WebSocket connections
   - Begin capturing audio data
   - Save the audio as a WAV file when the meeting ends

## Project-Specific Features

- Real-time audio data capture (16kHz, mono)
- WebSocket connection management for both signaling and media servers
- Automatic WAV conversion using FFmpeg
- Meeting-based recording with unique filenames
- Automatic cleanup of temporary files
- Keep-alive message handling
- Error handling for WebSocket connections
- URL validation handling

## Project-Specific Notes

- The application processes audio data at 16kHz sample rate, mono channel
- Audio is converted to WAV format using FFmpeg
- WAV files are saved with the naming format: `recording_[meeting_id].wav`
- Server runs on port 3000
- Webhook endpoint is available at `http://localhost:3000/webhook`
- Requires FFmpeg to be installed and accessible in your PATH

## Additional Setup Requirements

1. **Node.js** (v14 or higher recommended)
2. **FFmpeg** installation:
   - macOS: `brew install ffmpeg`
   - Ubuntu/Debian: `sudo apt-get install ffmpeg`
   - Windows: Download from [FFmpeg website](https://ffmpeg.org/download.html)
3. **ngrok** for exposing your local server to the internet
4. **Zoom App** configuration with RTMS scopes enabled

## Troubleshooting

1. **No Audio Files Generated**:
   - Verify FFmpeg is installed and accessible in your PATH
   - Check that the Zoom app has the correct RTMS scopes
   - Ensure the webhook URL is correctly configured in the Zoom app

2. **Connection Issues**:
   - Verify ngrok is running and the tunnel is active
   - Check that the Zoom app credentials in `.env` are correct
   - Ensure the webhook endpoint is accessible from the internet

3. **Audio Quality Issues**:
   - The application captures audio at 16kHz sample rate, mono channel
   - If audio quality is poor, check your network connection and Zoom meeting settings
