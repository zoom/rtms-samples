# Zoom RTMS Video and Audio save to AWS S3 Storage

This project demonstrates realtime audio and video capture using the Zoom RTMS. It stores the raw audio and video local. Thereafter utilizes ffmpeg cli to combine (muxing), and converts it into a mp4 file format.

## Prerequisites

Before running the application, ensure you have the following environment variables set in a `.env` file:
- `ZOOM_SECRET_TOKEN`: Secret token for URL validation
- `ZM_CLIENT_ID`: Zoom client ID
- `ZM_CLIENT_SECRET`: Zoom client secret

### Additional Environment Variables:
- `PORT`: The port on which the Express server runs (default: 3000)

- `AWS_REGION`: region for your s3 storage
- `AWS_ACCESS_KEY_ID`: access key id
- `AWS_SECRET_ACCESS_KEY`: secret access key
- `S3_BUCKET`: name of your s3 bucket

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
   - Begins receiving audio and video data
5. During the meeting:  
   - Maintains WebSocket connections with keep-alive messages
   - Receives raw audio & video data chunks and save them locally as is.
   - Handles any connection errors
6. When a meeting ends:  
   - Receives `meeting.rtms_stopped` event
   - Retrieve and combine (mux) the raw audio and raw video into a single audio/video file
   - Convert the audio/video file into mp4 format using ffmpeg cli.
   - Saves the files which ends with extension '.wav', '.mp4', '.vtt', '.srt', '.txt' into AWS S3 Storage
   - Closes all active WebSocket connections

## Running the Application

1. Start the server:
   ```bash
   node index.js  
   ```

2. Start a Zoom meeting. The application will:  
   - Receive the `meeting.rtms_started` event
   - Establish WebSocket connections
   - Begin capturing audio and video data
   - Append raw audio and raw video as seperate files during meeting.
   - After meeting ends, combines the raw audio and raw video into a single audio/video file
   - Thereafter converts the audio/video into mp4 format.

## Project-Specific Features  

- Realtime audio data capture (16kHz, mono)
- Realtime video data capture (H264, 720p, 25fps)
- WebSocket connection management for both signaling and media servers
- H264 & WAV muxing and conversion using FFmpeg
- MeetingUuid based created folders
- Upload all media files in MeetingUuid folder into AWS S3 Storage
- Keep-alive message handling
- Error handling for WebSocket connections
- URL validation handling

## Project-Specific Notes 

- The application processes audio data at 16kHz sample rate, mono channel
- The application processes video data at H264, 720p HD and 25fps
- Audio and Video is mux and converted to mp4 format using FFmpeg cli
- Only finalized files are saved to AWS S3 Storage after meeting, not during meeting to reduce excessive API calls and files fragmentation
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

1. **No Audio / Video Files Generated**:
   - Verify FFmpeg is installed and accessible in your PATH
   - Verify recordings folder is present in your root folder
   - Check that the Zoom app has the correct RTMS scopes
   - Ensure the webhook URL is correctly configured in the Zoom app

2. **Connection Issues**:
   - Verify ngrok is running and the tunnel is active
   - Check that the Zoom app credentials in `.env` are correct
   - Ensure the webhook endpoint is accessible from the internet

3. **Known Issues**:
   - The logic for combining audio and video file is over simplified for sample purpose. It just takes the first audio and first video file and combines them.

