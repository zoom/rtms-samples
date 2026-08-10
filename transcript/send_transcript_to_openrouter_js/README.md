# Send Transcript to OpenRouter

Stream real-time Zoom meeting transcripts to multiple AI models via OpenRouter and synthesize a unified response.

> **Built with [RTMSManager](../../library/README.md)** - Zoom's JavaScript library for real-time media streaming.

## Quick Start

```bash
npm install
cp .env.example .env   # Fill in your credentials
node index.js
```

Expose with ngrok: `ngrok http 3000`

## What This Sample Does

This sample captures live transcript data from Zoom meetings via RTMS and sends each transcript segment to multiple AI models simultaneously through OpenRouter's unified API. It then synthesizes the responses from all models into a single, well-validated answer using a designated synthesis model. This multi-model approach helps cross-check facts and generate more accurate responses.

## Prerequisites

- Node.js v18+
- Zoom account with RTMS enabled
- OpenRouter API key
- ngrok for local development

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ZOOM_SECRET_TOKEN` | Yes | Secret token for webhook URL validation |
| `ZOOM_CLIENT_ID` | Yes | Your Zoom app's Client ID |
| `ZOOM_CLIENT_SECRET` | Yes | Your Zoom app's Client Secret |
| `PORT` | No | Server port (default: 3000) |
| `WEBHOOK_PATH` | No | Webhook endpoint path (default: `/webhook`) |
| `OPENROUTER_API_KEY` | Yes | Your OpenRouter API key |
| `OPENROUTER_MODELS` | No | Comma-separated list of models to query (default: `x-ai/grok-4.1-fast`) |
| `OPENROUTER_SYNTHESIS_MODEL` | No | Model used to synthesize final answer (default: `x-ai/grok-4.1-fast`) |

## Code Walkthrough

### 1. Initialize RTMSManager

```javascript
const rtmsConfig = {
  logging: {
    enabled: true,
    logDir: path.join(__dirname, 'logs'),
    console: true
  },
  mediaSocketConnectionMode: process.env.MEDIA_SOCKET_CONNECTION_MODE || 'split',
  mediaTypes: RTMSManager.MEDIA.TRANSCRIPT,
  credentials: {
    meeting: {
      clientId: process.env.ZOOM_CLIENT_ID,
      clientSecret: process.env.ZOOM_CLIENT_SECRET,
      zoomSecretToken: process.env.ZOOM_SECRET_TOKEN,
    }
  },
  mediaParams: {
    transcript: {
      contentType: MEDIA_PARAMS.MEDIA_CONTENT_TYPE_TEXT,
      language: MEDIA_PARAMS.LANGUAGE_ID_ENGLISH,
    }
  }
};

await RTMSManager.init(rtmsConfig);
```

### 2. Set Up Webhook Handler

```javascript
const webhookManager = new WebhookManager({
  config: {
    webhookPath: process.env.WEBHOOK_PATH || '/webhook',
    zoomSecretToken: rtmsConfig.credentials.meeting.zoomSecretToken,
  },
  app: app
});

webhookManager.on('event', (event, payload) => {
  console.log('[send_to_openrouter] Webhook Event:', event);
  RTMSManager.handleEvent(event, payload);
});

webhookManager.setup();
```

### 3. Handle Transcript Events

```javascript
RTMSManager.on('transcript', async ({ text, userId, userName, timestamp, meetingId }) => {
  console.log(`[TRANSCRIPT] ${userName}: ${text}`);
  await contextualSynthesisFromMultipleModels(text);
});

RTMSManager.on('meeting.rtms_started', (payload) => {
  console.log('[send_to_openrouter] RTMS Started:', payload.meeting_uuid);
});

RTMSManager.on('meeting.rtms_stopped', (payload) => {
  console.log('[send_to_openrouter] RTMS Stopped:', payload.meeting_uuid);
});
```

### 4. Start the Server

```javascript
await RTMSManager.start();

server.listen(appConfig.port, () => {
  console.log(`[send_to_openrouter] Server listening on port ${appConfig.port}`);
  console.log(`[send_to_openrouter] Webhook endpoint: http://localhost:${appConfig.port}${process.env.WEBHOOK_PATH || '/webhook'}`);
});
```

## Key Files

| File | Purpose |
|------|---------|
| `index.js` | Main application entry point, sets up RTMSManager and webhook handling |
| `chatWithOpenrouter.js` | OpenRouter API integration with multi-model querying and response synthesis |

## How It Works

1. Server starts and initializes RTMSManager with transcript media type (flag 32)
2. WebhookManager listens for Zoom webhook events on the configured endpoint
3. When a meeting with RTMS starts, `meeting.rtms_started` event triggers connection setup
4. RTMSManager automatically handles WebSocket connections and authentication
5. As participants speak, transcript events are emitted with text and speaker info
6. Each transcript segment is sent to multiple AI models in parallel via OpenRouter
7. The system waits for all model responses to complete
8. A synthesis model receives all responses and generates a unified, validated answer
9. The final synthesized response is logged to the console
10. When the meeting ends, `meeting.rtms_stopped` closes connections gracefully

## Troubleshooting

**No OpenRouter responses**
- Verify your `OPENROUTER_API_KEY` is valid
- Check that the specified models are available on OpenRouter
- Review console logs for specific error messages

**Connection issues**
- Verify ngrok is running and the tunnel is active
- Check that Zoom app credentials in `.env` are correct
- Ensure the webhook endpoint is accessible from the internet

**Slow synthesis responses**
- The synthesis step waits for all models to respond before proceeding
- Consider using faster models or reducing the number of models queried
- The spinner shows elapsed time during synthesis for monitoring

**Model-specific errors**
- Some models may fail while others succeed; the system continues with available responses
- Check OpenRouter's model availability and pricing for your selected models

## See Also

- [RTMSManager Library Docs](../../library/README.md) - Full API reference
- [Zoom App Setup Guide](../../ZOOM_APP_SETUP.md) - Configure your Zoom app
- [Troubleshooting Guide](../../TROUBLESHOOTING.md) - Common issues
