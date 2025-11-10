# Zoom RTMS Video and Audio AWS IVS Streaming Project

This project demonstrates real-time audio and video capture using the Zoom RTMS (Real-Time Media Streaming) API. It streams audio and video to AWS IVS via FFmpeg in real-time.

## Features

- **Real-time Audio/Video Streaming**: Captures and streams audio/video from Zoom meetings to AWS IVS
- **Video Continuity**: Automatically injects black video frames when participant's video is muted/off
- **WebSocket Management**: Handles Zoom RTMS signaling and media WebSocket connections
- **FFmpeg Integration**: Uses FFmpeg for efficient H.264/AAC encoding and RTMP streaming to IVS
- **Keep-alive Handling**: Maintains stable WebSocket connections with proper keep-alive messages
- **Error Recovery**: Robust error handling and connection management

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
   - Setup pipes (video and audio) for IVS streaming
   - Sends media handshake with authentication
   - Begins receiving audio and video data
5. During the meeting:
   - Maintains WebSocket connections with keep-alive messages
   - Receives raw audio & video data chunks, and sends them as buffer into the respective audio and video pipes
   - ffmpeg reads the pipes and stream them to IVS
   - Handles any connection errors
6. When a meeting ends:
   - Receives `meeting.rtms_stopped` event
   - Stops ffmpeg from streaming to IVS any further
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

## Technical Specifications

- **Audio**: 16kHz sample rate, mono channel, uncompressed PCM
- **Video**: H.264 encoded, 720p resolution, 25fps
- **Streaming**: RTMP to AWS IVS via FFmpeg
- **Video Continuity**: Automatic injection of black H.264 keyframes when video is muted/off
- **WebSocket Management**: Dual WebSocket connections (signaling + media)
- **Keep-alive**: Automatic WebSocket keep-alive message handling
- **Error Handling**: Robust connection recovery and cleanup

## Architecture Notes

- **Data Flow**: Audio/Video buffers → Node.js pipes → FFmpeg → RTMP → AWS IVS
- **Video Continuity**: Pre-encoded black H.264 keyframes injected when video source stops
- **Connection Management**: Automatic cleanup of WebSocket connections and FFmpeg processes
- **Error Handling**: Graceful recovery from connection drops and streaming errors

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
