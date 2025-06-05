This project is based on https://github.com/zoom/rtms-developer-preview-js

# Zoom RTMS Video stream object detection project

This project demonstrates real-time object detection utilizing Zoom RTMS video stream. The video stream is sampled, and converted to an compatible image format for tensorflow object recognition  The detected object(s) and confidence level are then printed in the console log

## Prerequisites

Before running the application, ensure you have the following environment variables set in a `.env` file:
- `ZM_RTMS_CLIENT`: Your Zoom OAuth Client ID (required)
- `ZM_RTMS_SECRET`:Your Zoom OAuth Client Secret (required)

### Additional Environment Variables:
- `PORT`: The port on which the server runs (default: 8080)

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
   - Begins receiving all media data type (Audio, Video, Deskshare, Transcript, Chat etc...)
5. During the meeting:  
   - Maintains WebSocket connections with keep-alive messages
   - Receives and utilize ffmpeg to decode raw video data chunks
   - Passes the decoded image to tensorflow for object detection
   - Saves the image with boundary box overlay
   - Prints the object detected and confidence level in console log
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
   - Begin capturing video data
   - Encode the video data for object detection
   - Save the sampled image with boundary box
   - Print the detected objects and confidence level in console log

## Project-Specific Features  

- Real-time video data capture (H264, 720p HD, 25fps)
- WebSocket connection management for both signaling and media servers
- H264 conversion to image samples using FFmpeg
- Saving images with boundary box, in unique meetingUuid folders
- Keep-alive message handling
- Error handling for WebSocket connections
- URL validation handling

## Project-Specific Notes  

- The application processes video data in H264 format, 720p HD, and 25 fps
- Video is converted to image format using FFmpeg
- Server runs on port 3000 by default, if PORT is not specificed in .env
- Webhook endpoint is available at `http://localhost:PORT/`
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

1. **No Image Files and/or object detection logs Generated**:
   - Verify FFmpeg is installed and accessible in your PATH
   - Check that the Zoom app has the correct RTMS scopes
   - Ensure the webhook URL is correctly configured in the Zoom app

2. **Connection Issues**:
   - Verify ngrok is running and the tunnel is active
   - Check that the Zoom app credentials in `.env` are correct
   - Ensure the webhook endpoint is accessible from the internet

3. **Performance Quality Issues**:
   - For object detection, a modern CPU is required. While not required, it is recommended to use a GPU for high performence when performing object detection.
   - If video quality is poor, check your network connection and Zoom meeting settings



## Dependencies

- `@zoom/rtms`: Zoom's Real-Time Media SDK
- `dotenv`: Environment variable management


**SDK Installation Issues**:
   - Make sure you have the correct token for fetching prebuilt binaries
   - Check that you've installed the SDK correctly: `npm install github:zoom/rtms`
