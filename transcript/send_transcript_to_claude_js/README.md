# Send Transcript to Claude

Stream real-time Zoom meeting transcripts to Anthropic's Claude for AI-powered conversational analysis.

> **Built with [RTMSManager](../../library/README.md)** - Zoom's JavaScript library for real-time media streaming.

## Quick Start

```bash
npm install
cp .env.example .env   # Fill in your credentials
node index.js
```

Expose with ngrok: `ngrok http 3000`

## What This Sample Does

This sample captures live transcript data from Zoom meetings via RTMS and sends each transcript segment to Anthropic's Claude API. Unlike stateless calls, this implementation maintains conversation history, allowing Claude to provide contextual responses that build on previous transcript segments throughout the meeting.

## Prerequisites

- Node.js v18+
- Zoom account with RTMS enabled
- Anthropic API key with Claude access
- ngrok for local development

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ZOOM_SECRET_TOKEN` | Yes | Secret token for webhook URL validation |
| `ZOOM_CLIENT_ID` | Yes | Your Zoom app's Client ID |
| `ZOOM_CLIENT_SECRET` | Yes | Your Zoom app's Client Secret |
| `PORT` | No | Server port (default: 3000) |
| `WEBHOOK_PATH` | No | Webhook endpoint path (default: `/webhook`) |
| `ANTHROPIC_API_KEY` | Yes | Your Anthropic API key |

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
  console.log('[send_to_claude] Webhook Event:', event);
  RTMSManager.handleEvent(event, payload);
});

webhookManager.setup();
```

### 3. Handle Transcript Events

```javascript
RTMSManager.on('transcript', async ({ text, userId, userName, timestamp, meetingId }) => {
  console.log(`[TRANSCRIPT] ${userName}: ${text}`);
  
  try {
    const response = await chatWithClaude(text);
    console.log('[Claude Response]:', response);
  } catch (err) {
    console.error('[Claude Error] Failed to get response');
  }
});

RTMSManager.on('meeting.rtms_started', (payload) => {
  console.log('[send_to_claude] RTMS Started:', payload.meeting_uuid);
});

RTMSManager.on('meeting.rtms_stopped', (payload) => {
  console.log('[send_to_claude] RTMS Stopped:', payload.meeting_uuid);
});
```

### 4. Start the Server

```javascript
await RTMSManager.start();

server.listen(appConfig.port, () => {
  console.log(`[send_to_claude] Server listening on port ${appConfig.port}`);
  console.log(`[send_to_claude] Webhook endpoint: http://localhost:${appConfig.port}${process.env.WEBHOOK_PATH || '/webhook'}`);
});
```

## Key Files

| File | Purpose |
|------|---------|
| `index.js` | Main application entry point, sets up RTMSManager and webhook handling |
| `chatWithClaude.js` | Anthropic Claude API integration with conversation history management |

## How It Works

1. Server starts and initializes RTMSManager with transcript media type (flag 32)
2. WebhookManager listens for Zoom webhook events on the configured endpoint
3. When a meeting with RTMS starts, `meeting.rtms_started` event triggers connection setup
4. RTMSManager automatically handles WebSocket connections and authentication
5. As participants speak, transcript events are emitted with text and speaker info
6. Each transcript segment is added to the conversation history and sent to Claude
7. Claude analyzes the content with full context of previous messages
8. The assistant's response is added to history and logged to the console
9. This continues, building a contextual conversation throughout the meeting
10. When the meeting ends, `meeting.rtms_stopped` closes connections gracefully

## Troubleshooting

**No Claude responses**
- Verify your `ANTHROPIC_API_KEY` is valid
- Check that the API key has access to the Claude model
- Review console logs for specific error messages

**Connection issues**
- Verify ngrok is running and the tunnel is active
- Check that Zoom app credentials in `.env` are correct
- Ensure the webhook endpoint is accessible from the internet

**Context too long errors**
- The conversation history grows with each transcript segment
- For long meetings, consider implementing history truncation
- The current implementation uses Claude 3.5 Sonnet with a 1024 max token limit

## See Also

- [RTMSManager Library Docs](../../library/README.md) - Full API reference
- [Zoom App Setup Guide](../../ZOOM_APP_SETUP.md) - Configure your Zoom app
- [Troubleshooting Guide](../../TROUBLESHOOTING.md) - Common issues
