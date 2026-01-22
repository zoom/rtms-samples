# Zoom RTMS Transcription and AI Synthesis (OpenRouter)

This project captures realtime transcript data from Zoom meetings using Zoom's RTMS (Realtime Media Service) and synthesizes refined responses using multiple AI models via the OpenRouter API. It utilizes the shared `RTMSManager` and `WebhookManager` for robust connection handling.

## Features

- Realtime transcript data capture from Zoom meetings
- Automated connection management via `RTMSManager`
- Webhook validation and event handling via `WebhookManager`
- AI-based transcript processing using OpenRouter models
- Parallel querying of multiple models and synthesis of output
- Configurable models via environment variables

## Prerequisites

Create a `.env` file with the following variables configured:

```env
ZOOM_SECRET_TOKEN=your_zoom_secret
ZOOM_CLIENT_ID=your_client_id
ZOOM_CLIENT_SECRET=your_client_secret
OPENROUTER_API_KEY=your_openrouter_key
OPENROUTER_MODEL=x-ai/grok-4.1-fast            # Default model for single queries
OPENROUTER_MODELS=x-ai/grok-4.1-fast           # Comma-separated list for multi-model queries
OPENROUTER_SYNTHESIS_MODEL=x-ai/grok-4.1-fast  # Model used for synthesizing final answers
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

Transcript data is processed by the `contextualSynthesisFromMultipleModels()` function in `chatWithOpenrouter.js`, which performs the following steps:

1. Sends the transcript to multiple models (configured via `OPENROUTER_MODELS`).
2. Collects and aggregates responses from all successful model queries.
3. Synthesizes a final, consolidated answer using the model specified in `OPENROUTER_SYNTHESIS_MODEL`.

## Implementation Details

The project leverages shared library components:

- **RTMSManager**: Manages signaling and media WebSocket connections, authentication, and keep-alives.
- **WebhookManager**: Handles Zoom webhook validation and distributes events.

### Workflow

1. **Initialization**: The server initializes `RTMSManager` and `WebhookManager`.
2. **Meeting Start**: On `meeting.rtms_started`, `RTMSManager` automatically connects to Zoom's media servers.
3. **Transcript Handling**:
   - The application listens for `transcript` events from `RTMSManager`.
   - The payload includes `text`, `userName`, `timestamp`, `meetingId`, etc.
   - Transcripts are forwarded to the OpenRouter-based AI synthesis pipeline.
4. **Meeting End**: On `meeting.rtms_stopped`, connections are gracefully closed.

## Transcript Data Payload

The `transcript` event provides the following data:

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

## File Structure

```
.
├── index.js                  # Main server logic and RTMS event handling
├── chatWithOpenrouter.js    # AI model interaction and synthesis logic
├── .env                      # Environment configuration file
```

## Troubleshooting

| Issue | Recommendation |
|-------|----------------|
| No transcript received | Ensure Zoom RTMS scopes are enabled and app is properly configured |
| Connection errors | Check credentials and network exposure via tunneling |
| No AI output | Verify OpenRouter API key and model configurations in `.env` |
