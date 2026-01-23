# Save Transcript to VTT/SRT/TXT

Capture real-time Zoom meeting transcripts and save them in VTT, SRT, and plain text formats.

> **Built with [RTMSManager](../../library/README.md)** - Zoom's JavaScript library for real-time media streaming.

## Quick Start

```bash
npm install
cp .env.example .env   # Fill in your credentials
node index.js
```

Expose with ngrok: `ngrok http 3000`

## What This Sample Does

This sample captures live transcript data from Zoom meetings via RTMS and automatically saves them in three formats: WebVTT (.vtt), SubRip (.srt), and plain text (.txt). Each meeting's transcripts are stored in a dedicated folder named by the meeting UUID, with accurate timestamps for subtitle synchronization.

## Prerequisites

- Node.js v18+
- Zoom account with RTMS enabled
- ngrok for local development

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ZOOM_SECRET_TOKEN` | Yes | Secret token for webhook URL validation |
| `ZOOM_CLIENT_ID` | Yes | Your Zoom app's Client ID |
| `ZOOM_CLIENT_SECRET` | Yes | Your Zoom app's Client Secret |
| `PORT` | No | Server port (default: 3000) |
| `WEBHOOK_PATH` | No | Webhook endpoint path (default: `/webhook`) |

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
  mediaTypesFlag: 32,
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
  console.log('[save_transcript] Webhook Event:', event);
  RTMSManager.handleEvent(event, payload);
});

webhookManager.setup();
```

### 3. Handle Transcript Events

```javascript
RTMSManager.on('transcript', (payload) => {
  console.log('='.repeat(60));
  console.log('[TRANSCRIPT PAYLOAD]', JSON.stringify(payload, null, 2));
  console.log('='.repeat(60));
  
  const { text, userName, timestamp, meetingId, startTime, endTime } = payload;
  writeTranscriptToVtt(userName, text, meetingId, startTime, endTime, timestamp);
});

RTMSManager.on('meeting.rtms_started', (payload) => {
  console.log('[save_transcript] RTMS Started:', payload.meeting_uuid);
});

RTMSManager.on('meeting.rtms_stopped', (payload) => {
  console.log('[save_transcript] RTMS Stopped:', payload.meeting_uuid);
});
```

### 4. Start the Server

```javascript
await RTMSManager.start();

server.listen(appConfig.port, () => {
  console.log(`[save_transcript] Server listening on port ${appConfig.port}`);
  console.log(`[save_transcript] Webhook endpoint: http://localhost:${appConfig.port}${process.env.WEBHOOK_PATH || '/webhook'}`);
});
```

## Key Files

| File | Purpose |
|------|---------|
| `index.js` | Main application entry point, sets up RTMSManager and webhook handling |
| `writeTranscriptToVtt.js` | Utility functions to format and save transcripts in VTT, SRT, and TXT formats |

## How It Works

1. Server starts and initializes RTMSManager with transcript media type (flag 32)
2. WebhookManager listens for Zoom webhook events on the configured endpoint
3. When a meeting with RTMS starts, `meeting.rtms_started` event triggers connection setup
4. RTMSManager automatically handles WebSocket connections and authentication
5. As participants speak, transcript events are emitted with text, speaker info, and timestamps
6. `writeTranscriptToVtt()` saves each transcript segment to VTT, SRT, and TXT files
7. Files are organized in `recordings/{meetingUUID}/` folders
8. When the meeting ends, `meeting.rtms_stopped` closes connections gracefully

## Troubleshooting

**No transcript files generated**
- Verify the `recordings/` folder exists in the project root
- Check that your Zoom app has RTMS scopes enabled
- Ensure the webhook URL is correctly configured in the Zoom app

**Connection issues**
- Verify ngrok is running and the tunnel is active
- Check that Zoom app credentials in `.env` are correct
- Ensure the webhook endpoint is accessible from the internet

**Empty or missing timestamps**
- Confirm `startTime` and `endTime` are being received in the payload
- Check console logs for the full transcript payload structure

## See Also

- [RTMSManager Library Docs](../../library/README.md) - Full API reference
- [Zoom App Setup Guide](../../ZOOM_APP_SETUP.md) - Configure your Zoom app
- [Troubleshooting Guide](../../TROUBLESHOOTING.md) - Common issues
