
# Zoom RTMS Transcription and AI Synthesis

This project captures real-time transcript data from Zoom meetings using Zoom's RTMS (Real-Time Meeting Service) and synthesizes a refined response using multiple AI models via the OpenRouter API.

## Features

- Real-time transcript data capture from Zoom meetings
- Webhook validation using HMAC signatures
- Management of WebSocket connections (signaling and media)
- AI-based transcript processing using OpenRouter models
- Parallel querying of multiple models and synthesis of output
- Modular architecture

## Prerequisites

Create a `.env` file with the following variables configured:

```env
ZOOM_SECRET_TOKEN=your_zoom_secret
ZM_CLIENT_ID=your_client_id
ZM_CLIENT_SECRET=your_client_secret
OPENROUTER_API_KEY=your_openrouter_key
PORT=3000
WEBHOOK_PATH=/webhook
```

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Start the server:
   ```bash
   node index.js
   ```

3. (Optional) Use a tunneling service such as `ngrok` to expose the server to the public internet.

## AI Integration

Transcript data from RTMS (`msg_type 17`) is processed by the `contextualSynthesisFromMultipleModels()` function in `chatWithOpenrouter.js`, which performs the following steps:

1. Sends the transcript to multiple models:
   - meta-llama/llama-4-maverick:free
   - meta-llama/llama-4-scout:free

2. Collects and aggregates responses

3. Synthesizes a final, consolidated answer using:
   - anthropic/claude-3-haiku

## Workflow

### Meeting Start

- Receive `meeting.rtms_started` event
- Establish signaling WebSocket connection
- Perform handshake and retrieve media server URL

### Media Connection

- Establish WebSocket connection to media server
- Perform handshake for audio, video, and transcript
- Listen for `msg_type 17` (transcript data)

### Transcript Handling

- Forward transcript to OpenRouter-based AI synthesis pipeline
- Aggregate and output final response

### Meeting End

- Receive `meeting.rtms_stopped` event
- Close all active WebSocket connections

## File Structure

```
.
├── index.js                  # Main server logic and webhook handling
├── chatWithOpenrouter.js    # AI model interaction logic
├── .env                      # Environment configuration file
```

## Troubleshooting

| Issue | Recommendation |
|-------|----------------|
| No transcript received | Ensure Zoom RTMS scopes are enabled and app is properly configured |
| WebSocket errors | Check credentials and network exposure via tunneling |
| No AI output | Verify OpenRouter API key and connectivity |

## Notes

- FFmpeg is required if future expansion to audio/video conversion is planned.
- No transcript data is persisted to disk in this implementation.
- Extend the current implementation to save transcripts in VTT/SRT/TXT if required.
