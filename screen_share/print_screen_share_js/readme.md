# Zoom RTMS Sharescreen Capture Service

This Node.js application listens for Zoom Real-Time Media Streaming (RTMS) events and captures shared screen data from ongoing Zoom meetings. It uses WebSocket connections to receive and process media data, including sharescreen frames, audio, video, transcript, and chat.

## Project Overview

- Listens for Zoom webhook events related to RTMS.
- Connects to signaling and media WebSocket servers.
- Captures and saves shared screen (deskshare) data using a custom handler.
- Supports multiple media types: audio, video, deskshare, chat, and transcript.
- Includes basic frontend serving via Express.

## Environment Variables

Create a `.env` file with the following keys:

```env
ZOOM_SECRET_TOKEN=your_zoom_secret_token
ZM_CLIENT_ID=your_zoom_client_id
ZM_CLIENT_SECRET=your_zoom_client_secret
PORT=3000
WEBHOOK_PATH=/webhook
```

## Features

- Validates Zoom webhook with encrypted response.
- WebSocket handshakes secured with HMAC SHA256 signatures.
- Real-time media stream capture from Zoom meetings.
- Dedicated logic to process sharescreen data using `saveSharescreen.js`.
- Handles keep-alive requests and maintains connection health.
- Automatically cleans up connections when meetings end.

## Endpoints

- `GET /` – Serves the main index page.
- `GET /home` – Serves the Zoom iframe interface.
- `POST /webhook` – Handles Zoom RTMS webhook events.

## Deskshare Handshake Requirement

Before any deskshare (shared screen) data can be received via the media WebSocket, a proper media handshake **must** be performed. This handshake specifies the intent to receive deskshare frames by including `deskshare` parameters in the `media_params` object of the handshake request.

### Required Handshake Payload

```js
const handshake = {
    msg_type: 3,
    protocol_version: 1,
    meeting_uuid: meetingUuid,
    rtms_stream_id: streamId,
    signature,
    media_type: 32,
    payload_encryption: false,
    media_params: {
        audio: { ... },
        video: { ... },
        deskshare: {
            codec: 5 // JPG
        },
        chat: { ... }
    }
};
```

If this handshake is not sent or the `deskshare` property is missing, the server will not emit any deskshare frames (`msg_type: 16`).

## saveSharescreen.js – Deskshare Capture Logic

This module processes and saves incoming deskshare frames. It performs the following:

- **Base64 Data Handling**
  - Strips off `data:` prefix if present.
  - Converts base64 to binary buffer.

- **Format Detection**
  - **JPEG**: Starts with `FFD8`, ends with `FFD9`.
  - **PNG**: Matches PNG header.
  - **H.264**: Identified using common start codes (`00 00 00 01` or `00 00 01`).
  - Unknown formats are logged and skipped.

- **Output Logic**
  - Creates `recordings/` folder if it doesn’t exist.
  - Constructs a filename using sanitized `user_id` and `timestamp`.
  - Skips JPEGs that:
    - Are below 1000 bytes.
    - Are within the first 3 frames (to avoid low-quality noise).
  - Writes:
    - **JPEG/PNG** → Individual `.jpg` or `.png` file.
    - **H.264** → Appended to user-specific `.h264` stream file.

- **Filename Safety**
  - Removes non-alphanumeric characters from `user_id`.

## How It Works

1. A Zoom RTMS-enabled app triggers events when a meeting starts or ends.
2. The server receives `meeting.rtms_started` and connects to Zoom’s signaling WebSocket.
3. After a successful handshake, it receives the media server URL and connects to it.
4. The application sends a media handshake requesting deskshare frames.
5. The server receives and processes `msg_type: 16` (deskshare), passing it to `handleShareData`.
6. WebSocket connections are closed when `meeting.rtms_stopped` is received.

## Prerequisites

- Node.js v14 or higher
- A valid Zoom App with RTMS permissions
- Ngrok or another tunneling service for public webhook exposure

## Running the Server

```bash
node index.js
```

## Notes

- JPEG filtering logic is in place to skip redundant or very small frames.
- Extend `saveSharescreen.js` for more formats or metadata if required.
