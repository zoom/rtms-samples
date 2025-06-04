# Zoom RTMS Media Receiver (.NET Core)

This .NET Core example demonstrates how to receive real-time audio, video, and transcript data from a Zoom meeting using the RTMS (Real-Time Media Streaming) service.

The server connects to Zoom’s RTMS infrastructure via WebSocket, handles webhook events, and logs media events via the console.

## Prerequisites

- .NET 6.0 SDK or later
- A Zoom account with RTMS enabled
- Zoom App credentials (Client ID and Client Secret)
- Zoom Secret Token for webhook validation

## Setup

1. Restore dependencies:
```bash
dotnet restore
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

1. Start the server:
```bash
dotnet run
```

2. Expose your server using a tool like ngrok:
```bash
ngrok http 3000
```

3. Configure your Zoom App's webhook endpoint to match the ngrok URL:
```
https://<your-ngrok-subdomain>.ngrok.io/webhook
```

4. Start a Zoom meeting and enable RTMS.

## How it Works

1. The server listens for RTMS webhook events at the configured path.
2. On receiving a `meeting.rtms_started` event, it connects to Zoom’s signaling WebSocket server.
3. Upon successful handshake, it connects to the media WebSocket server.
4. Media messages are received and identified by their `msg_type`:
   - **14**: Audio
   - **15**: Video
   - **17**: Transcript
5. Messages are printed to the console to confirm receipt.

## Notes

- This example uses `System.Net.WebSockets` for real-time streaming and `System.Text.Json` for JSON processing.
- Keep-alive messages are handled automatically for both signaling and media connections.
- The app is implemented using the ASP.NET Core Minimal API model.
- No frontend interface (HTML) is provided in this example.
- This is a logging-only example; modify the handlers to save or process the media content as needed.

## Security

- Never commit your `.env` file or secrets to version control.
- Use HTTPS in production and validate incoming webhook requests for authenticity.
