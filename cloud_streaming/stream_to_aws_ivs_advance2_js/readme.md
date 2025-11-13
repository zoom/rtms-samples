# Zoom RTMS Video and Audio AWS IVS Streaming project

This project demonstrates real-time audio and video capture using the Zoom RTMS. It streams the Audio and Video to AWS IVS via ffmpeg in real-time.
This advance project includes injection of empty buffer. Black video keyframes are injected when user's video is turned off.

## Prerequisites

Before running the application, ensure you have the following environment variables set in a `.env` file:
- `ZOOM_SECRET_TOKEN`: Secret token for URL validation
- `ZOOM_CLIENT_ID`: Zoom client ID
- `ZOOM_CLIENT_SECRET`: Zoom client secret

### Additional Environment Variables:
- `PORT`: The port on which the Express server runs (default: 3000)
- `IVS_RTMP_URL`: RTMP URL for your AWS IVS channel (e.g., rtmps://your-endpoint/app/your-stream-key)

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
   - Starts IVS streaming with FFmpeg pipes for audio and video
   - Sends media handshake with authentication
   - Begins receiving audio and video data
5. During the meeting:
   - Maintains WebSocket connections with keep-alive messages
   - Audio data is written directly to FFmpeg pipe in real-time
   - Video data is buffered with timestamps and processed every 40ms
   - Timer processes buffered video packets, using the most recent packet or injecting black frames for gaps
   - FFmpeg reads from pipes and streams to IVS
   - Logs timing information including timer drift, packet intervals, and buffer status
   - Handles any connection errors
6. When a meeting ends:
   - Receives `meeting.rtms_stopped` event
   - Stops FFmpeg streaming to IVS
   - Closes all active WebSocket connections

## Running the Application

1. Start the server:
   ```bash
   node index.js  
   ```

2. Start a Zoom meeting. The application will:
   - Receive the `meeting.rtms_started` event
   - Establish WebSocket connections
   - Setup audio and video pipe to prepare for IVS streaming via ffmpeg
   - Begin receiving audio and video data, send them as buffer into respective audio and video pipes
   - After meeting ends, stops ffmpeg streaming to IVS

## Project-Specific Features

- Real-time audio data capture and immediate streaming (16kHz, mono)
- Real-time video data capture with buffering and gap filling (H264, 720p, 25fps)
- WebSocket connection management for both signaling and media servers
- Timer-based video processing every 40ms with black frame injection for gaps
- Comprehensive logging including timer drift, packet intervals, and buffer status
- FFmpeg streams to IVS by reading from audio and video pipes
- Keep-alive message handling for connection stability
- Error handling for WebSocket connections
- URL validation handling

## Project-Specific Notes

- Audio data is written directly to FFmpeg pipe in real-time without buffering
- Video data is buffered with timestamps and processed in batches every 40ms
- Black video frames are injected automatically when no video packets are available
- Timer drift is monitored and logged for performance tracking
- Packet intervals are logged to monitor stream timing patterns
- Server runs on port 3000 by default, if PORT is not specified in .env
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

1. **IVS Stream does not work**:
   - Verify FFmpeg is installed and accessible in your PATH
   - Verify that you are subscribing to H264 video format, and uncompressed raw audio format
   - Check that the Zoom app has the correct RTMS scopes
   - Ensure the webhook URL is correctly configured in the Zoom app
   - Verify the IVS_RTMP_URL is correct and the IVS channel is active

2. **Connection Issues**:
   - Verify ngrok is running and the tunnel is active
   - Check that the Zoom app credentials in `.env` are correct
   - Ensure the webhook endpoint is accessible from the internet

3. **Known Issues**:
   - There might be video artifacts generated on IVS. Additional fine tuning is necessary on ffmpeg parameters.
