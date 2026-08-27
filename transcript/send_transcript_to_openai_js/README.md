# Send Transcript to OpenAI

Stream real-time Zoom meeting transcripts to OpenAI's GPT-4o for AI-powered analysis and responses.

> **Built with [RTMSManager](../../library/README.md)** - Zoom's JavaScript library for real-time media streaming.

## Quick Start

```bash
npm install
cp .env.example .env   # Fill in your credentials
node index.js
```

Expose with ngrok: `ngrok http 3000`

## What This Sample Does

This sample captures live transcript data from Zoom meetings via RTMS and sends each transcript segment to OpenAI's Chat API. The AI assistant analyzes or responds to the transcript content in real-time, enabling use cases like meeting summarization, question answering, or live AI assistance during calls.

## Prerequisites

- Node.js v18+
- Zoom account with RTMS enabled
- OpenAI API key with GPT-4o access
- ngrok for local development

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ZOOM_SECRET_TOKEN` | Yes | Secret token for webhook URL validation |
| `ZOOM_CLIENT_ID` | Yes | Your Zoom app's Client ID |
| `ZOOM_CLIENT_SECRET` | Yes | Your Zoom app's Client Secret |
| `PORT` | No | Server port (default: 3000) |
| `WEBHOOK_PATH` | No | Webhook endpoint path (default: `/webhook`) |
| `OPENAI_API_KEY` | Yes | Your OpenAI API key |

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
  console.log('[send_to_openai] Webhook Event:', event);
  RTMSManager.handleEvent(event, payload);
});

webhookManager.setup();
```

### 3. Handle Transcript Events

```javascript
RTMSManager.on('transcript', async ({ text, userId, userName, timestamp, meetingId }) => {
  console.log(`[TRANSCRIPT] ${userName}: ${text}`);
  
  try {
    const response = await chatWithTranscript(text);
    console.log('[OpenAI Response]:', response);
  } catch (err) {
    console.error('[OpenAI Error] Failed to get response');
  }
});

RTMSManager.on('meeting.rtms_started', (payload) => {
  console.log('[send_to_openai] RTMS Started:', payload.meeting_uuid);
});

RTMSManager.on('meeting.rtms_stopped', (payload) => {
  console.log('[send_to_openai] RTMS Stopped:', payload.meeting_uuid);
});
```

### 4. Start the Server

```javascript
await RTMSManager.start();

server.listen(appConfig.port, () => {
  console.log(`[send_to_openai] Server listening on port ${appConfig.port}`);
  console.log(`[send_to_openai] Webhook endpoint: http://localhost:${appConfig.port}${process.env.WEBHOOK_PATH || '/webhook'}`);
});
```

## Key Files

| File | Purpose |
|------|---------|
| `index.js` | Main application entry point, sets up RTMSManager and webhook handling |
| `chatWithOpenAI.js` | OpenAI API integration using GPT-4o for transcript analysis |

## How It Works

1. Server starts and initializes RTMSManager with transcript media type (flag 32)
2. WebhookManager listens for Zoom webhook events on the configured endpoint
3. When a meeting with RTMS starts, `meeting.rtms_started` event triggers connection setup
4. RTMSManager automatically handles WebSocket connections and authentication
5. As participants speak, transcript events are emitted with text and speaker info
6. Each transcript segment is sent to OpenAI's GPT-4o model via the Chat API
7. The AI assistant analyzes the content and returns a response
8. Responses are logged to the console for monitoring
9. When the meeting ends, `meeting.rtms_stopped` closes connections gracefully

## Troubleshooting

**No OpenAI responses**
- Verify your `OPENAI_API_KEY` is valid and has sufficient credits
- Check that the API key has access to the GPT-4o model
- Review console logs for specific error messages

**Connection issues**
- Verify ngrok is running and the tunnel is active
- Check that Zoom app credentials in `.env` are correct
- Ensure the webhook endpoint is accessible from the internet

**Rate limiting errors**
- OpenAI may rate limit requests; consider adding delays between API calls
- Check your OpenAI usage dashboard for quota limits

## See Also

- [RTMSManager Library Docs](../../library/README.md) - Full API reference
- [Zoom App Setup Guide](../../ZOOM_APP_SETUP.md) - Configure your Zoom app
- [Troubleshooting Guide](../../TROUBLESHOOTING.md) - Common issues

## Docker

The project sends RTMS transcript text to OpenAI. Its multi-stage Dockerfile keeps build tooling out of the final runtime image and does not hard-code a CPU architecture.

Build and run it from the `rtms-samples` repository root:

```bash
docker build -f transcript/send_transcript_to_openai_js/Dockerfile -t rtms-transcript-send_transcript_to_openai_js .
docker run --rm --env-file transcript/send_transcript_to_openai_js/.env -p 3000:3000 rtms-transcript-send_transcript_to_openai_js
```

Run the build from the repository root because the Dockerfile uses repository-relative paths. Runtime secrets are supplied with `--env-file` and are excluded from the image build context.
