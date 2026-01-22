# Zoom RTMS Integration with OpenAI GPT-4o

This project integrates Zoom RTMS (Realtime Media Streaming) with OpenAI's GPT-4o model to analyze and respond to live transcript data in realtime. It utilizes the shared `RTMSManager` and `WebhookManager` for robust connection and event management.

---

## Overview

When a Zoom meeting starts with RTMS enabled:
- The server receives webhook events via `WebhookManager`.
- `RTMSManager` automatically establishes signaling and media WebSocket connections.
- The application listens for `transcript` events from `RTMSManager`.
- Transcript text is sent to OpenAI GPT-4o for contextual analysis.
- The response is logged to the console.

---

## Environment Setup

Create a `.env` file with the following keys:

```env
ZOOM_SECRET_TOKEN=your_zoom_secret_token
ZOOM_CLIENT_ID=your_zoom_client_id
ZOOM_CLIENT_SECRET=your_zoom_client_secret
OPENAI_API_KEY=your_openai_api_key
PORT=3000
WEBHOOK_PATH=/webhook
```

---

## Implementation Details

The project uses a modular design with shared library components:

1. **RTMSManager**: Manages the low-level RTMS protocol, including connection state, handshakes, and data parsing.
2. **WebhookManager**: Handles Zoom's webhook validation (URL verification) and event distribution.

### Workflow

1. **Initialization**: The server initializes `RTMSManager` with Zoom credentials.
2. **Meeting Start**: On `meeting.rtms_started`, `RTMSManager` connects to Zoom media servers.
3. **Data Processing**:
   - `RTMSManager` emits a `transcript` event when new data arrives.
   - The payload contains `text`, `userName`, `timestamp`, `meetingId`, etc.
   - The application forwards the transcript text to the `chatWithTranscript()` function.
4. **AI Analysis**: OpenAI's GPT-4o processes the transcript and returns a contextual response.
5. **Meeting End**: On `meeting.rtms_stopped`, all active connections are closed.

---

## Transcript Data Payload

The `transcript` event provides the following fields:

- `text`: The transcript text content
- `userId`: Speaker's user ID
- `userName`: Speaker's name
- `timestamp`: Event timestamp (microseconds)
- `meetingId`: Unique meeting UUID
- `streamId`: RTMS stream ID
- `productType`: "meeting" or "session"
- `startTime`: Utterance start time (milliseconds)
- `endTime`: Utterance end time (milliseconds)
- `language`: Language ID
- `attribute`: Transcript attribute

---

## Usage

### 1. Install Dependencies

```bash
npm install
```

### 2. Run the Server

```bash
node server.js
```

---

## chatWithOpenAI.js

This module contains a function to send transcript data to the OpenAI API:

```js
export async function chatWithTranscript(transcriptText) { ... }
```

- **Model Used**: `gpt-4o`
- **Context**: Adds a system prompt for contextualization before sending transcript as a user message.
- **Error Handling**: Handles and logs API errors gracefully.

---

## License

MIT License
