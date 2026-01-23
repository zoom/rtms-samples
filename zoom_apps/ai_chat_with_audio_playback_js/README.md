# AI Chat with Audio Playback

Real-time AI chatbot that responds to meeting transcripts with text and audio playback in the browser.

> **Built with [RTMSManager](../../library/README.md)** - Zoom's JavaScript library for real-time media streaming.

## Quick Start

```bash
npm install
cp .env.example .env   # Fill in your credentials
node index.js
```

Expose with ngrok: `ngrok http 3000`

## What This Sample Does

This sample creates an AI-powered assistant that listens to Zoom meeting transcripts and responds both with text and synthesized speech. When participants speak in the meeting, the transcript is sent to OpenRouter for AI processing, and the response is delivered to a web frontend where it's displayed as text and played back as audio using Deepgram's text-to-speech API.

## Prerequisites

- Node.js v18+
- Zoom account with RTMS enabled
- Zoom App configured in Marketplace (with Zoom Apps SDK capabilities)
- OpenRouter API key (for AI responses)
- Deepgram API key (for text-to-speech)
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
| `MODE` | No | Event mode: "webhook" or "websocket" (default: webhook) |
| `zoomWSURLForEvents` | No | Zoom WebSocket URL (required if MODE=websocket) |
| `ZOOM_S2S_CLIENT_ID` | No | Server-to-Server OAuth client ID |
| `ZOOM_S2S_CLIENT_SECRET` | No | Server-to-Server OAuth client secret |
| `ZOOM_ACCOUNT_ID` | No | Zoom account ID for S2S OAuth |
| `OPENROUTER_API_KEY` | Yes | API key for OpenRouter |
| `OPENROUTER_MODEL` | No | AI model to use (default: x-ai/grok-4.1-fast) |
| `OPENROUTER_SYNTHESIS_MODEL` | No | Model for synthesis (default: anthropic/claude-3-haiku) |
| `DEEPGRAM_API_KEY` | Yes | API key for Deepgram text-to-speech |

## Code Walkthrough

### 1. Initialize RTMSManager

```javascript
const rtmsConfig = {
  logging: 'info',
  logDir: path.join(__dirname, 'logs'),
  credentials: {
    meeting: {
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      zoomSecretToken: config.zoomSecretToken,
    },
    websocket: {
      zoomWSURLForEvents: config.zoomWSURLForEvents,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
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
if (config.mode === 'webhook') {
  const webhookManager = new WebhookManager({
    config: {
      webhookPath: config.webhookPath,
      zoomSecretToken: config.zoomSecretToken,
    },
    app: app
  });

  webhookManager.on('event', (event, payload) => {
    console.log('[Consumer] Webhook Event:', event);
    RTMSManager.handleEvent(event, payload);
  });

  webhookManager.setup();
}
```

### 3. Set Up Frontend WebSocket

```javascript
import { setupFrontendWss, broadcastToFrontendClients, sharedServices } from './frontendWss.js';

sharedServices.textToSpeech = textToSpeechBase64;
setupFrontendWss(server);
```

### 4. Handle Transcript Events with AI and Audio

```javascript
RTMSManager.on('transcript', async ({ text, userId, userName, timestamp, meetingId, streamId, productType }) => {
  console.log('Transcript received:', text);
  
  try {
    const aiResponse = await chatWithOpenRouter(text);
    console.log('AI Response:', aiResponse);

    broadcastToFrontendClients({
      type: 'text',
      data: aiResponse,
      metadata: {
        source: 'transcript_response',
        originalText: text,
        userName: userName,
        timestamp: Date.now()
      }
    });

    if (sharedServices.textToSpeech) {
      const base64Audio = await sharedServices.textToSpeech(aiResponse);
      broadcastToFrontendClients({
        type: 'audio',
        data: base64Audio,
        metadata: {
          source: 'transcript_response',
          originalText: text,
          aiResponse: aiResponse,
          timestamp: Date.now()
        }
      });
    }
  } catch (error) {
    console.error('Error processing transcript:', error);
  }
});
```

### 5. Start the Server

```javascript
await RTMSManager.start();

server.listen(config.port, () => {
  console.log(`Server running at http://localhost:${config.port}`);
  console.log(`Webhook available at http://localhost:${config.port}${config.webhookPath}`);
  console.log(`Frontend WebSocket available at ws://localhost:${config.port}/ws`);
});
```

## Key Files

| File | Purpose |
|------|---------|
| `index.js` | Main entry point - initializes RTMSManager, webhook, and WebSocket server |
| `config.js` | Configuration loader for environment variables |
| `frontendWss.js` | Frontend WebSocket server for browser communication |
| `chatWithOpenrouter.js` | OpenRouter AI chat integration |
| `deepgramService.js` | Deepgram text-to-speech service |
| `public/index.ejs` | Frontend UI template |
| `public/audio-client.js` | Browser-side audio playback handler |

## How It Works

1. User joins a Zoom meeting with RTMS enabled
2. Zoom sends RTMS events to the webhook endpoint
3. RTMSManager processes the events and connects to the media stream
4. Transcripts are received and sent to OpenRouter for AI processing
5. AI response is broadcast to connected frontend clients as text
6. Response is converted to audio using Deepgram TTS
7. Audio is sent to frontend clients as base64 and played in the browser

## Troubleshooting

| Issue | Solution |
|-------|----------|
| No audio playback | Verify DEEPGRAM_API_KEY is set correctly |
| WebSocket not connecting | Check FRONTEND_WSS_URL_TO_CONNECT_TO matches your ngrok URL |
| No AI responses | Verify OPENROUTER_API_KEY and model availability |
| Webhook not receiving events | Ensure ngrok is running and URL is registered in Zoom Marketplace |

## See Also

- [RTMSManager Library Docs](../../library/README.md) - Full API reference
- [Zoom App Setup Guide](../../ZOOM_APP_SETUP.md) - Configure your Zoom app
- [Troubleshooting Guide](../../TROUBLESHOOTING.md) - Common issues
