
# Zoom RTMS Integration with OpenAI GPT-4o

This project integrates Zoom RTMS (Real-Time Media Streaming) with OpenAI's GPT-4o model to analyze and respond to live transcript data in real-time. It includes two main components:

1. Webhook Server for Zoom RTMS events and WebSocket handling.
2. OpenAI Integration to process transcript messages.

---

## Overview

When a Zoom meeting starts with RTMS enabled:
- The server receives webhook events (`meeting.rtms_started`, `meeting.rtms_stopped`).
- It establishes signaling and media WebSocket connections to Zoom's media servers.
- It listens for transcript (`msg_type: 17`) messages, which are sent to OpenAI GPT-4o for contextual analysis.
- The response is logged to the console or can be extended to other destinations.

---

## File Structure

```
.
├── chatWithOpenAI.js        # Sends transcript to OpenAI Chat API
└── server.js                # Express app handling Zoom RTMS webhook + WebSocket
```

---

## Environment Setup

Create a `.env` file with the following keys:

```env
OPENAI_API_KEY=your_openai_api_key
PORT=3000
ZOOM_SECRET_TOKEN=your_zoom_secret_token
ZM_CLIENT_ID=your_zoom_client_id
ZM_CLIENT_SECRET=your_zoom_client_secret
WEBHOOK_PATH=/webhook
```

---

## Usage

### 1. Install Dependencies

```bash
npm install express dotenv ws openai
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

- Model Used: `gpt-4o`
- Adds a system prompt for contextualization before sending transcript as user message.
- Handles and logs errors.

---

## WebSocket Flow in server.js

### Event Triggers:

- `meeting.rtms_started`: Opens signaling socket → triggers media socket connection.
- `meeting.rtms_stopped`: Closes both connections.

### WebSocket Message Types:

- 17: TRANSCRIPT (analyzed by GPT-4o)

---


## Example GPT Response

On receiving transcript:  
```json
{
  "msg_type": 17,
  "content": {
    "user_id": "123",
    "user_name": "John",
    "data": "How does this model work?"
  }
}
```

The assistant might reply:  
"This model is a transformer-based neural network trained to understand and generate human-like language."

---

## License

MIT License
