# Zoom RTMS Video and Audio transcoding and streaming project

This project demonstrates real-time audio and video capture using the Zoom RTMS. It transcode the Audio and Video buffer, and saves the HLS live streaming files in the public/hls folder.

## Prerequisites

Before running the application, ensure you have the following environment variables set in a `.env` file:
- `ZOOM_SECRET_TOKEN`: Secret token for URL validation
- `ZM_CLIENT_ID`: Zoom client ID
- `ZM_CLIENT_SECRET`: Zoom client secret

### Additional Environment Variables:
- `PORT`: The port on which the Express server runs (default: 3000)

## Implementation Details

The application follows this sequence:

1. Starts an Express server on port 3000, and serves a html page to view the stream `/player`
2. Listens for webhook events at `/webhook` endpoint
3. Handles URL validation challenges from Zoom
4. When a meeting starts:
   - Receives `meeting.rtms_started` event
   - Establishes WebSocket connection to signaling server
   - Sends handshake with authentication signature
   - Receives media server URL from signaling server
   - Establishes WebSocket connection to media server
   - Setup pipes (video and audio) for live transcoding using ffmpeg
   - Sends media handshake with authentication
   - Begins receiving audio and video data
5. During the meeting:  
   - Maintains WebSocket connections with keep-alive messages
   - Receives raw audio & video data chunks, and sends them as buffer into the respective audio and video pipes
   - ffmpeg reads the pipes and transcode them into segments in public/hls folder
   - Handles any connection errors
6. When a meeting ends:  
   - Receives `meeting.rtms_stopped` event
   - Stops ffmpeg live transcoding any further
   - Closes all active WebSocket connections

## Running the Application

1. Start the server:
   ```bash
   node index.js  
   ```

2. Start a Zoom meeting. The application will:  
   - Receive the `meeting.rtms_started` event
   - Establish WebSocket connections
   - Setup audio and video pipe to prepare for live transcoding via ffmpeg
   - Begin receiving audio and video data, send them as buffer into respective audio and video pipes
   - After meeting ends, stops ffmpeg live transcoding

## Project-Specific Features  

- Real-time audio data capture (16kHz, mono)
- Real-time video data capture (H264, 720p, 25fps)
- WebSocket connection management for both signaling and media servers
- FFmpeg does HLS live transcoding by retrieve audio and video buffers from pipes
- Audio/video buffers are sent to pipes in real-time
- Keep-alive message handling
- Error handling for WebSocket connections
- URL validation handling

## Project-Specific Notes 

- The application processes audio data at 16kHz sample rate, mono channel
- The application processes video data at H264, 720p HD and 25fps
- Audio and Video buffer is first passed into pipes. FFmpeg retrieves these Audio/Video buffer from the pipes and live transcode them
- Server runs on port 3000 by default, if PORT is not specificed in .env
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

1. **Live Transcoding does not work Generated**:
   - Verify FFmpeg is installed and accessible in your PATH
   - Verify that you are subscribing to H264 video format, and uncompressed raw audio format
   - Check that the Zoom app has the correct RTMS scopes
   - Ensure the webhook URL is correctly configured in the Zoom app

2. **Connection Issues**:
   - Verify ngrok is running and the tunnel is active
   - Check that the Zoom app credentials in `.env` are correct
   - Ensure the webhook endpoint is accessible from the internet

3. **Known Issues**:
   
