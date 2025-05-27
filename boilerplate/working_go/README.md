# Print Incoming Audio Video Transcript message type Example

This example demonstrates how to receive audio video and transcript from a Zoom meeting using the RTMS (Real-Time Media Streaming) service.
It does not print out the data, but uses an if else statement to seperate audio, video and transcript via the msg_type parameter.

## Prerequisites

- Python 3.7 or higher
- A Zoom account with RTMS enabled
- Zoom App credentials (Client ID and Client Secret)
- Zoom Secret Token for webhook validation

## Setup

1. Install the required dependencies:
```bash
go get github.com/gorilla/websocket github.com/joho/godotenv

```

2. Create a `.env` file in the same directory with your Zoom credentials:
```
ZOOM_SECRET_TOKEN=your_secret_token
ZM_CLIENT_ID=your_client_id
ZM_CLIENT_SECRET=your_client_secret
```

## Running the Example

1. Start the server:
```bash
go run main.go
```

2. The server will start on port 3000. You'll need to expose this port to the internet using a tool like ngrok:
```bash
ngrok http 3000
```

3. Configure your Zoom App's webhook URL to point to your exposed endpoint (e.g., `https://your-ngrok-url/webhook`)

4. Start a Zoom meeting and enable RTMS. The server will receive and print the incoming audio data.

## How it Works

1. The server listens for webhook events from Zoom
2. When RTMS starts, it establishes WebSocket connections to Zoom's signaling and media servers
3. Audio, Video and Transcript data is received through the media WebSocket connection
4. The audio/video/transcript msg type is printed to the console

## Notes

- This is a basic example that checks the msg type and prints the data type received. In a production environment, you would typically process or save this data.
- The server handles both signaling and media WebSocket connections
- Keep-alive messages are automatically responded to maintain the connection 