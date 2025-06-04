# Zoom RTMS realtime speech-to-text service with audio stream

This project demonstrates the use of 3rd party speech-to-text service which accepts audio buffer as an input. The sample here utilize Microsoft Azure's speech-to-text service (Azure Speech service). Utilizing RTMS, it sends the audio buffer to Azure's API in realtime, and prints out the transcribed text in the console log.

## Prerequisites

Before running the application, ensure you have the following environment variables set in a `.env` file:
- `ZOOM_SECRET_TOKEN`: Secret token for URL validation
- `ZM_CLIENT_ID`: Zoom client ID
- `ZM_CLIENT_SECRET`: Zoom client secret
- `PORT`: 3000
- `WEBHOOK_PATH`: "/webhook"
- `AZURE_SPEECH_KEY`: Azure Speech Service key
- `AZURE_REGION`: Region the Azure Speech Service is in


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
   - Sends audio data (as buffer) to Azure's Speech-to-Text Service
   - Prints out the transribed text on the console
5. During the meeting:  
   - Maintains WebSocket connections with keep-alive messages
   - Receives and stores raw audio data chunks
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
   - Begin capturing audio data
   - Continuously send audio buffer to Azure Speech to Text Service, and prints out transribed text in console

## Project-Specific Features

- Realtime audio data capture (16kHz, mono)
- WebSocket connection management for both signaling and media servers
- Keep-alive message handling
- Error handling for WebSocket connections
- URL validation handling

## Project-Specific Notes 

- The application processes audio data at 16kHz sample rate, mono channel
- API used is from Microsoft Azure
- Server runs on port 3000
- Webhook endpoint is available at `http://localhost:3000/webhook`

## Additional Setup Requirements 

1. **Node.js** (v14 or higher recommended)
2. **ngrok** for exposing your local server to the internet
3. **Zoom App** configuration with RTMS scopes enabled

## Troubleshooting  

1. **No transcribed logs printed out**:
   - Check that you have a valid subscription service from Microsoft Azure Speech services.
   - Check that the Zoom app has the correct RTMS scopes
   - Check that you are requesting for the correct audio media_type and audio codec
   - Ensure the webhook URL is correctly configured in the Zoom app

2. **Connection Issues**:
   - Verify ngrok is running and the tunnel is active
   - Check that the Zoom app credentials in `.env` are correct
   - Ensure the webhook endpoint is accessible from the internet

3. **Audio Quality Issues**:
   - The application captures audio at 16kHz sample rate, mono channel
   - If audio quality is poor, check your network connection and Zoom meeting settings
