# Zoom RTMS Realtime Media Streaming Service

This Python application demonstrates how to manually start and stop Zoom's Realtime Media Streaming (RTMS).

## Project Overview

- Listens for Zoom webhook events related to RTMS.
- Connects to signaling and media WebSocket servers.
- Captures and processes realtime transcript data.
- Supports multiple media types: audio, video, transcript, and chat.
- Includes automatic RTMS stop functionality after a configurable duration.

## Environment Variables

Create a `.env` file with the following keys:

```env
ZOOM_CLIENT_ID=your_zoom_client_id
ZOOM_CLIENT_SECRET=your_zoom_client_secret
WEBHOOK_PATH=/webhook
access_token=your_zoom_access_token
PORT=3000
# Optional: start/stop RTMS for a specific invitee already in the meeting.
# Omit to use the user represented by access_token.
RTMS_PARTICIPANT_USER_ID=zoom_user_id
```

## Features

- Validates Zoom webhook events for meeting lifecycle.
- WebSocket handshakes secured with HMAC SHA256 signatures.
- Realtime transcript stream capture from Zoom meetings.
- Automatic RTMS stop scheduling after 10 seconds (configurable).
- Handles keep-alive requests and maintains connection health.
- Automatically cleans up connections when meetings end.
- Optionally targets a specific joined invitee with `RTMS_PARTICIPANT_USER_ID`.

## Endpoints

- `POST /webhook` – Handles Zoom RTMS webhook events.

## Webhook Events Handled

- `meeting.started` – Initiates RTMS start and schedules automatic stop
- `meeting.rtms_started` – Connects to signaling WebSocket
- `meeting.rtms_stopped` – Logs meeting stop event

## How It Works

### Step 1: Webhook Receiver
The application listens for Zoom webhook events on `/webhook` endpoint.

### Step 2: Meeting Started Event
When `meeting.started` is received:
- **Step 2a**: Listen to meeting started event
- **Step 2b**: Get access token from environment. To implement complete logic for authorization, please visit [here](https://developers.zoom.us/docs/integrations/oauth/)
- **Step 2c**: Make API call to start RTMS using the meeting ID from the webhook.

If `RTMS_PARTICIPANT_USER_ID` is set, the request includes
`settings.participant_user_id`. The participant must be an invitee who has
already joined the meeting. Without it, Zoom uses the user represented by the
access token.

### Step 3: RTMS Started Event
When `meeting.rtms_started` is received, the application connects to Zoom's signaling WebSocket.

### Step 4: Generate Signature
Creates HMAC SHA256 signature for authentication handshake using client ID, meeting UUID, and stream ID.

### Step 5: WebSocket 1 - Signaling Connection
- Connects to Zoom's signaling WebSocket server
- Sends handshake request with meeting details and signature
- Receives media server URL upon successful handshake

### Step 6: WebSocket 2 - Media Connection
- Connects to media WebSocket server
- Sends media handshake requesting transcript stream
- Receives and processes real-time transcript data

### Step 7: Stop RTMS
Automatically stops RTMS after 10 seconds using Zoom API.

## Message Types Handled

- `msg_type: 1` – HANDSHAKE_REQUEST
- `msg_type: 2` – HANDSHAKE_RESPONSE
- `msg_type: 3` – MEDIA_HANDSHAKE_REQUEST
- `msg_type: 4` – MEDIA_HANDSHAKE_RESPONSE
- `msg_type: 5` – TRANSCRIPT_DATA
- `msg_type: 7` – CLIENT_READY_ACK
- `msg_type: 12` – KEEP_ALIVE_REQUEST
- `msg_type: 13` – KEEP_ALIVE_RESPONSE

The REST start/stop request uses `PATCH /live_meetings/{meetingId}/rtms_app/status`.
The access token needs the appropriate RTMS status scope, such as
`meeting:write` or the corresponding admin/participant granular scope.

## Prerequisites

- Python 3.7 or higher
- A valid Zoom App with webhook events and meeting and RTMS scopes.
- Ngrok or another tunneling service for public webhook exposure

## Installation

```bash
pip install -r requirements.txt
```

## Running the Server

```bash
python rtms.py
```

The server will start on port 3000 and listen for webhook events.

## Dependencies

- Flask: Web framework for handling HTTP requests
- websockets: Async WebSocket client for real-time communication
- requests: HTTP client for API calls
- python-dotenv: Environment variable management

## Notes

- RTMS is automatically stopped after 10 seconds to demo the stop action of the API
- All WebSocket connections are properly closed when meetings end
- Transcript data is logged to console for debugging

## Docker

The project exposes the Python example for starting and stopping RTMS. Its multi-stage Dockerfile keeps build tooling out of the final runtime image and does not hard-code a CPU architecture.

Build and run it from the `rtms-samples` repository root:

```bash
docker build -f rtms_api/manual_start_stop_using_python/Dockerfile -t rtms-rtms_api-manual_start_stop_using_python .
docker run --rm --env-file rtms_api/manual_start_stop_using_python/.env -p 3000:3000 rtms-rtms_api-manual_start_stop_using_python
```

Run the build from the repository root because the Dockerfile uses repository-relative paths. Runtime secrets are supplied with `--env-file` and are excluded from the image build context.
