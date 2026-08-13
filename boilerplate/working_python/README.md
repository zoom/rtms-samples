# Print Incoming Audio Video Transcript message type Example

This example demonstrates how to receive audio, video, screen share, transcript, and chat from a Zoom meeting using RTMS.
It logs the received media type without printing the raw media payload.

## Prerequisites

- Python 3.7 or higher
- A Zoom account with RTMS enabled
- Zoom App credentials (Client ID and Client Secret)
- Zoom Secret Token for webhook validation

## Setup

1. Install the required dependencies:
```bash
pip install -r requirements.txt
```

2. Create a `.env` file in the same directory with your Zoom credentials:
```
ZOOM_SECRET_TOKEN=your_secret_token
ZOOM_CLIENT_ID=your_client_id
ZOOM_CLIENT_SECRET=your_client_secret
MEDIA_SOCKET_CONNECTION_MODE=split
MEDIA_TYPES_FLAG=11
```

`MEDIA_TYPES_FLAG` combines audio (`1`), video (`2`), screen share (`4`),
transcript (`8`), and chat (`16`). Split mode expands the mask into separate
media sockets, so `11` opens audio, video, and transcript sockets with handshake
values `1`, `2`, and `8`.

For a single unified media socket, use:

```env
MEDIA_SOCKET_CONNECTION_MODE=unified
MEDIA_TYPES_FLAG=32
```

Unified mode requires `32`; combined masks such as `11` must use split mode.

## Running the Example

1. Start the server:
```bash
gunicorn index:app --bind 0.0.0.0:3000
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
3. Split mode opens one WebSocket for each selected media type; unified mode uses `server_urls.all`
4. The audio/video/transcript msg type is printed to the console

## Notes

- This is a basic example that checks the msg type and prints the data type received. In a production environment, you would typically process or save this data.
- The server handles both signaling and media WebSocket connections
- Keep-alive messages are automatically responded to maintain the connection
