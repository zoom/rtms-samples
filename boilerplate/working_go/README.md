# Zoom RTMS Media Receiver (Go)

This Go example demonstrates how to receive real-time audio, video, and transcript data from a Zoom meeting using the RTMS (Real-Time Media Streaming) service.

The server connects to Zoom’s RTMS infrastructure via WebSocket, handles webhook events, and logs media data types to the console.

## Prerequisites

- Go 1.18 or higher
- A Zoom account with RTMS enabled
- Zoom App credentials (Client ID and Client Secret)
- Zoom Secret Token for webhook validation

## Setup

1. Install dependencies (via `go get` or your preferred Go module system):

```bash
go get github.com/gorilla/websocket github.com/joho/godotenv

```

```bash
go mod tidy
```

2. Create a `.env` file in the root directory with the following content:
```
ZOOM_SECRET_TOKEN=your_secret_token
ZM_CLIENT_ID=your_client_id
ZM_CLIENT_SECRET=your_client_secret
PORT=3000
WEBHOOK_PATH=/webhook
```

## Running the Example

1. Start the Go server:
```bash
go run main.go
```

2. Expose your local server using a tool like ngrok:
```bash
ngrok http 3000
```

3. Configure your Zoom App's webhook to use the exposed endpoint:
```
https://<your-ngrok-subdomain>.ngrok.io/webhook
```

4. Start a Zoom meeting and enable RTMS.

## How it Works

1. The Go server listens for webhook events at the defined endpoint.
2. On receiving `meeting.rtms_started`, it establishes WebSocket connections to Zoom's signaling and media servers.
3. Media messages are received through the WebSocket connection:
   - **msg_type 14**: Audio
   - **msg_type 15**: Video
   - **msg_type 17**: Transcript
4. The message type is printed to the console for each incoming message.

## Notes

- No files are written to disk in this example. Modify the handlers to process and store data if needed.
- Keep-alive messages are handled automatically to maintain WebSocket connections.
- This example does not include a frontend or HTML page like the Node.js version.
- Clean disconnection is handled on `meeting.rtms_stopped`.

## Security

- Keep your `.env` file private and secure.
- In production, consider validating the origin of incoming webhook requests and using HTTPS.




