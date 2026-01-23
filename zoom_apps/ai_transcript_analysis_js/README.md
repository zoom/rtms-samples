# AI Transcript Analysis

Real-time personality trait analysis from meeting transcripts with live visualization.

> **Built with [RTMSManager](../../library/README.md)** - Zoom's JavaScript library for real-time media streaming.

## Quick Start

```bash
npm install
cp .env.example .env   # Fill in your credentials
node index.js
```

Expose with ngrok: `ngrok http 3000`

## What This Sample Does

This sample analyzes meeting transcripts in real-time to identify personality traits like Curiosity, Empathy, Assertiveness, Creativity, and Analytical thinking. As participants speak, the AI categorizes their phrases and accumulates trait scores over time. Results are visualized in a D3.js-powered frontend that updates live as the meeting progresses.

## Prerequisites

- Node.js v18+
- Zoom account with RTMS enabled
- Zoom App configured in Marketplace (with Zoom Apps SDK capabilities)
- OpenRouter API key (for AI trait analysis)
- ngrok for local development

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ZOOM_SECRET_TOKEN` | Yes | Secret token from your Zoom app |
| `ZOOM_CLIENT_ID` | Yes | Client ID from your Zoom app |
| `ZOOM_CLIENT_SECRET` | Yes | Client secret from your Zoom app |
| `PORT` | No | Server port (default: 3000) |
| `WEBHOOK_PATH` | No | Webhook endpoint path (default: /webhook) |
| `OPENROUTER_API_KEY` | Yes | API key for OpenRouter |
| `DEFAULT_OPENROUTER_MODEL` | No | AI model to use (default: meta-llama/llama-4-scout:free) |

## Code Walkthrough

### 1. Initialize RTMSManager

```javascript
const rtmsConfig = {
  logging: 'info',
  logDir: path.join(__dirname, 'logs'),
  credentials: {
    meeting: {
      clientId: process.env.ZOOM_CLIENT_ID,
      clientSecret: process.env.ZOOM_CLIENT_SECRET,
      zoomSecretToken: process.env.ZOOM_SECRET_TOKEN,
    },
  },
  mediaParams: {
    audio: {
      contentType: MEDIA_PARAMS.MEDIA_CONTENT_TYPE_RTP,
      sampleRate: MEDIA_PARAMS.AUDIO_SAMPLE_RATE_SR_16K,
      channel: MEDIA_PARAMS.AUDIO_CHANNEL_MONO,
      codec: MEDIA_PARAMS.MEDIA_PAYLOAD_TYPE_L16,
      dataOpt: MEDIA_PARAMS.MEDIA_DATA_OPTION_AUDIO_MIXED_STREAM,
      sendRate: 100,
    },
    transcript: {
      contentType: MEDIA_PARAMS.MEDIA_CONTENT_TYPE_TEXT,
      language: MEDIA_PARAMS.LANGUAGE_ID_ENGLISH,
    },
  }
};

await RTMSManager.init(rtmsConfig);
```

### 2. Set Up Webhook Handler

```javascript
const webhookManager = new WebhookManager({
  config: {
    webhookPath: process.env.WEBHOOK_PATH || '/',
    zoomSecretToken: rtmsConfig.credentials.meeting.zoomSecretToken,
  },
  app: app
});

webhookManager.on('event', (event, payload) => {
  console.log('[Consumer] Webhook Event:', event);
  RTMSManager.handleEvent(event, payload);
});

webhookManager.setup();
```

### 3. Set Up Frontend Manager and WebSocket

```javascript
const frontendManager = new FrontendManager({
  config: {
    port: appConfig.port,
    serveStaticEnabled: true,
    viewsPath: path.join(__dirname, 'public'),
    frontendWssUrl: process.env.FRONTEND_WSS_URL_TO_CONNECT_TO || '',
    frontendWssPath: '/ws'
  },
  app: app
});
frontendManager.setup();

const frontendWssManager = new FrontendWssManager({
  config: {
    frontendWssEnabled: true,
    frontendWssPath: '/ws'
  },
  server: server
});
frontendWssManager.setup();
```

### 4. Handle Transcript Events with Trait Analysis

```javascript
RTMSManager.on('transcript', async ({ text, userId, userName, timestamp, meetingId, streamId, productType }) => {
  console.log('Transcript received:', text);
  
  const { current: traitsCount, total } = await extractAndAccumulateTraits(text);

  console.log("Trait Counts (this message):", traitsCount);
  console.log("Accumulated Trait Totals:", total);

  frontendWssManager.broadcastToFrontendClients({
    type: 'transcript',
    content: text,
    user: userName,
    timestamp: Date.now(),
    traits: total
  });
});
```

### 5. Start the Server

```javascript
await RTMSManager.start();

server.listen(appConfig.port, () => {
  console.log(`Server running at http://localhost:${appConfig.port}`);
  console.log(`Frontend WebSocket available at ws://localhost:${appConfig.port}/ws`);
});
```

## Key Files

| File | Purpose |
|------|---------|
| `index.js` | Main entry point - initializes RTMSManager, managers, and server |
| `chatWithOpenrouterForTraits.js` | AI trait extraction and accumulation logic |
| `public/index.ejs` | Frontend UI template with D3.js visualization |
| `public/lib/d3.v7.min.js` | D3.js library for data visualization |

## How It Works

1. User joins a Zoom meeting with RTMS enabled
2. Zoom sends RTMS events to the webhook endpoint
3. RTMSManager processes events and receives transcripts
4. Each transcript is analyzed by AI to extract personality traits:
   - **Curiosity** - Questions, exploration, wonder
   - **Empathy** - Understanding, compassion, support
   - **Assertiveness** - Confidence, directness, leadership
   - **Creativity** - Innovation, imagination, originality
   - **Analytical** - Logic, data-driven, problem-solving
5. Trait counts are accumulated across the meeting
6. Results are broadcast to the frontend via WebSocket
7. D3.js visualization updates in real-time showing trait distribution

## Troubleshooting

| Issue | Solution |
|-------|----------|
| No trait data appearing | Check OPENROUTER_API_KEY is valid |
| Visualization not updating | Verify WebSocket connection in browser console |
| Webhook not receiving events | Ensure ngrok URL is registered in Zoom Marketplace |
| JSON parse errors | Check AI model is returning valid JSON format |

## See Also

- [RTMSManager Library Docs](../../library/README.md) - Full API reference
- [Zoom App Setup Guide](../../ZOOM_APP_SETUP.md) - Configure your Zoom app
- [Troubleshooting Guide](../../TROUBLESHOOTING.md) - Common issues
