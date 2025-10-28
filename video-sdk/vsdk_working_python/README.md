# Zoom Video SDK Sample (Python)

This example demonstrates how to receive audio video and transcript from a Zoom session using the Video SDK service.
It does not print out the data, but uses an if else statement to seperate audio, video and transcript via the msg_type parameter.

## Prerequisites

- Python 3.7 or higher
- Zoom Video SDK credentials (SDK Key and Secret)

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
```

## Running the Example

1. Start the server:
```bash
python3 index:app --bind 0.0.0.0:3000
```

2. The server will start on port 3000. You'll need to expose this port to the internet using a tool like ngrok:
```bash
ngrok http 3000
```

3. Configure your Video SDK app's webhook URL to point to your exposed endpoint (e.g., `https://your-ngrok-url/webhook`)

4. Start a Video SDK session and begin streaming. The server will receive and print the incoming audio data.

## Folder Structure

```
.
├── index.py                  # Main entry point that handles webhook events, WebSocket connections, and media processing
├── .env                      # Secrets and config variables (not committed)
├── .env.example              # Template for environment variables
├── requirements.txt          # Dependencies
├── README.md                 # This file
├── .gitignore                # Git ignore rules
├── __pycache__/              # Python bytecode (not committed)
└── venv/                     # Virtual environment (not committed)
```

## Architecture

This sample is implemented as a single `index.py` file that contains all the functionality:

1. **Environment Configuration** - Loads settings from .env file
2. **HTTP Server** - Flask server handling webhook endpoints
3. **WebSocket Management** - Handles signaling and media connections to Zoom
4. **Media Processing** - Processes incoming audio, video, and transcript data
5. **Client Broadcast** - Forwards events to clients

**System Communication**

        ┌──────────────┐
        │  Zoom SDK    │ ─────► HTTP Webhooks
        └──────────────┘           (session events)
              │
              ▼
        ┌──────────────┐
        │  index.py    │◄────────── WebSocket connections
        └──────────────┘       (signaling + media streams)
              │
              ▼
        ┌──────────────┐
        │ Client Apps  │ ◄───────── Real-time data
        └──────────────┘       (processed media streams)

## How it Works

1. The server listens for Video SDK webhook events from Zoom
2. When the session starts, it establishes WebSocket connections to Zoom's signaling and media servers
3. Audio, Video and Transcript data is received through the media WebSocket connection
4. The audio/video/transcript msg type is printed to the console

## Security

- Keep the `.env` file secret and do not commit to version control.
- In production, run behind HTTPS and validate webhook signatures.

## Notes

- This is a basic example that checks the msg type and prints the data type received. In a production environment, you would typically process or save this data.
- The server handles both signaling and media WebSocket connections
- Keep-alive messages are automatically responded to maintain the connection
