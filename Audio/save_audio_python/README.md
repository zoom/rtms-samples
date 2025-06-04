# Save Incoming Audio Example

This example demonstrates how to receive and save incoming audio data from a Zoom meeting using the RTMS (Real-Time Media Streaming) service. The audio is saved as a WAV file when the meeting ends.

## Prerequisites

- Python 3.7 or higher
- FFmpeg installed on your system
- A Zoom account with RTMS enabled
- Zoom App credentials (Client ID and Client Secret)
- Zoom Secret Token for webhook validation

## Setup

1. Install the required dependencies:
```bash
pip install -r requirements.txt
```

2. Make sure FFmpeg is installed on your system:
   - On macOS: `brew install ffmpeg`
   - On Ubuntu: `sudo apt-get install ffmpeg`
   - On Windows: Download from [FFmpeg website](https://ffmpeg.org/download.html)

3. Create a `.env` file in the same directory with your Zoom credentials:
```
ZOOM_SECRET_TOKEN=your_secret_token
ZM_CLIENT_ID=your_client_id
ZM_CLIENT_SECRET=your_client_secret
PORT = 3000
WEBHOOK_PATH = "/webhook"
  
```

## Running the Example

1. Start the server:
```bash
python save_incoming_audio.py
```

2. The server will start on port 3000. You'll need to expose this port to the internet using a tool like ngrok:
```bash
ngrok http 3000
```

3. Configure your Zoom App's webhook URL to point to your exposed endpoint (e.g., `https://your-ngrok-url/webhook`)

4. Start a Zoom meeting and enable RTMS. The server will receive and save the audio data.

## How it Works

1. The server listens for webhook events from Zoom
2. When RTMS starts, it establishes WebSocket connections to Zoom's signaling and media servers
3. Audio data is received through the media WebSocket connection and stored in memory
4. When the meeting ends, the audio data is:
   - Combined into a single raw audio file
   - Converted to WAV format using FFmpeg
   - Saved with a filename based on the meeting UUID

## Notes

- The audio is saved in 16-bit PCM format at 16kHz sample rate with mono channel
- The raw audio file is automatically deleted after conversion to WAV
- The WAV file is saved in the same directory as the script
- The server handles both signaling and media WebSocket connections
- Keep-alive messages are automatically responded to maintain the connection 