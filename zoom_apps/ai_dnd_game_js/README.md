# AI Dungeons & Dragons Game

Play a voice-controlled D&D game during Zoom meetings with an AI Dungeon Master.

> **Built with [RTMSManager](../../library/README.md)** - Zoom's JavaScript library for real-time media streaming.

## Quick Start

```bash
npm install
cp .env.example .env   # Fill in your credentials
node index.js
```

Expose with ngrok: `ngrok http 3000`

## What This Sample Does

This sample transforms your Zoom meeting into an interactive Dungeons & Dragons session. An AI Dungeon Master listens to what participants say via real-time transcripts and responds with narrative descriptions, NPC dialogue, and adventure choices. The game state persists throughout the meeting, creating a continuous roleplaying experience displayed in a web-based interface.

## Prerequisites

- Node.js v18+
- Zoom account with RTMS enabled
- Zoom App configured in Marketplace (with Zoom Apps SDK capabilities)
- OpenRouter API key (for AI Dungeon Master)
- ngrok for local development

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ZOOM_SECRET_TOKEN` | Yes | Secret token from your Zoom app |
| `ZOOM_CLIENT_ID` | Yes | Client ID from your Zoom app |
| `ZOOM_CLIENT_SECRET` | Yes | Client secret from your Zoom app |
| `PORT` | No | Server port (default: 3000) |
| `WEBHOOK_PATH` | No | Webhook endpoint path (default: /webhook) |
| `FRONTEND_WSS_URL_TO_CONNECT_TO` | Yes | WebSocket URL for frontend (e.g., wss://yoururl.ngrok.com/ws) |
| `OPENROUTER_API_KEY` | Yes | API key for OpenRouter |
| `OPENROUTER_MODEL` | No | AI model to use (default: x-ai/grok-4.1-fast) |

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
      contentType: MEDIA_PARAMS.MEDIA_CONTENT_TYPE_RAW_AUDIO,
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
    viewsPath: path.join(__dirname, 'views'),
    staticPath: path.join(__dirname, 'public'),
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

### 4. Handle Transcript Events with D&D Game Logic

```javascript
RTMSManager.on('transcript', async ({ text, userId, userName, timestamp, meetingId, streamId, productType }) => {
  console.log('Transcript received:', text);
  
  const dmResult = await handleTranscript(userName, text);

  if (dmResult) {
    console.log(`DM response for ${userName}:`, dmResult.narration);
    
    frontendWssManager.broadcastToFrontendClients({
      type: 'dm_response',
      content: text,
      user: userName,
      timestamp: Date.now(),
      gameresponse: dmResult,
    });
  }
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
| `dndGame.js` | D&D game logic with conversation history management |
| `chatWithOpenrouter.js` | OpenRouter AI integration for Dungeon Master responses |
| `views/index.ejs` | Frontend UI template for game display |

## How It Works

1. User joins a Zoom meeting with RTMS enabled
2. Zoom sends RTMS events to the webhook endpoint
3. RTMSManager processes events and receives transcripts
4. Each player's speech is formatted as `"{PlayerName} says: "{text}""`
5. The AI Dungeon Master maintains conversation history for context
6. DM responds with narrative descriptions and game content:
   ```javascript
   const history = [
     {
       role: 'system',
       content: 'You are a Dungeon Master narrating a fantasy roleplaying game. Be descriptive and interactive. Offer clear choices.',
     },
   ];
   ```
7. Responses are broadcast to the frontend for display
8. Game state persists throughout the meeting session

## Troubleshooting

| Issue | Solution |
|-------|----------|
| DM not responding | Check OPENROUTER_API_KEY and model availability |
| Game history lost | Restart maintains history; check for server restarts |
| WebSocket disconnects | Verify FRONTEND_WSS_URL_TO_CONNECT_TO matches ngrok URL |
| Webhook not receiving events | Ensure ngrok URL is registered in Zoom Marketplace |

## See Also

- [RTMSManager Library Docs](../../library/README.md) - Full API reference
- [Zoom App Setup Guide](../../ZOOM_APP_SETUP.md) - Configure your Zoom app
- [Troubleshooting Guide](../../TROUBLESHOOTING.md) - Common issues
