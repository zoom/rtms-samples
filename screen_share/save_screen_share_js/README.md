# Save Screen Share to Images

Captures Zoom screen share streams and saves individual frames as image files.

> **Built with [RTMSManager](../../library/README.md)** - Zoom's JavaScript library for real-time media streaming.

## Quick Start

```bash
npm install
cp .env.example .env   # Fill in your credentials
node index.js
```

Expose with ngrok: `ngrok http 3000`

## What This Sample Does

This sample connects to Zoom's Real-Time Media Streaming (RTMS) API and captures screen share data from meetings. When participants share their screen, the application receives JPEG frames and saves them to a `recordings` directory organized by meeting ID. The sample automatically detects image formats (JPEG, PNG, H.264) and filters out small or initial frames to ensure quality output.

## Prerequisites

- Node.js v18+
- Zoom account with RTMS enabled
- Zoom App credentials (Client ID, Client Secret, Secret Token)
- ngrok for local development

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ZOOM_SECRET_TOKEN` | Yes | Zoom webhook secret token for verification |
| `ZOOM_CLIENT_ID` | Yes | Zoom App Client ID |
| `ZOOM_CLIENT_SECRET` | Yes | Zoom App Client Secret |
| `PORT` | No | Server port (default: 3000) |
| `WEBHOOK_PATH` | No | Webhook endpoint path (default: /webhook) |

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
  mediaTypesFlag: 4,
  credentials: {
    meeting: {
      clientId: process.env.ZOOM_CLIENT_ID,
      clientSecret: process.env.ZOOM_CLIENT_SECRET,
      zoomSecretToken: process.env.ZOOM_SECRET_TOKEN,
    }
  },
  mediaParams: {
    deskshare: {
      codec: MEDIA_PARAMS.MEDIA_PAYLOAD_TYPE_JPG,
      resolution: MEDIA_PARAMS.MEDIA_RESOLUTION_HD,
      fps: 5,
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
  console.log('[save_screen_share] Webhook Event:', event);
  RTMSManager.handleEvent(event, payload);
});

webhookManager.setup();
```

### 3. Handle Screen Share Events

```javascript
RTMSManager.on('sharescreen', (payload) => {
  const { buffer, userId, timestamp, meetingId } = payload;
  handleShareData(buffer, userId, timestamp, meetingId);
});

RTMSManager.on('meeting.rtms_started', (payload) => {
  console.log('[save_screen_share] RTMS Started:', payload.meeting_uuid);
  resetFrameCounter();
});

RTMSManager.on('meeting.rtms_stopped', (payload) => {
  console.log('[save_screen_share] RTMS Stopped:', payload.meeting_uuid);
});
```

### 4. Start the Server

```javascript
await RTMSManager.start();

server.listen(appConfig.port, () => {
  console.log(`[save_screen_share] Server listening on port ${appConfig.port}`);
  console.log(`[save_screen_share] Webhook endpoint: http://localhost:${appConfig.port}${process.env.WEBHOOK_PATH || '/webhook'}`);
});
```

## Key Files

| File | Purpose |
|------|---------|
| `index.js` | Main entry point - initializes RTMSManager, sets up webhooks and event handlers |
| `saveSharescreen.js` | Handles screen share data - detects format, filters frames, and saves to disk |
| `.env.example` | Template for environment variables |
| `package.json` | Project dependencies |

## How It Works

1. The application starts an Express server and initializes RTMSManager with screen share configuration
2. WebhookManager listens for Zoom webhook events and forwards them to RTMSManager
3. When a meeting starts RTMS streaming, the frame counter resets
4. Screen share frames arrive via the `sharescreen` event as binary buffers
5. The `handleShareData` function detects the image format (JPEG, PNG, or H.264)
6. JPEG frames smaller than 1KB or the first 3 frames are skipped for quality
7. Valid frames are saved to `recordings/{meetingId}/` with filenames like `{userId}_{timestamp}.jpg`
8. H.264 video data is appended to a single file per user for later processing

## Troubleshooting

**No frames being saved**
- Ensure someone is actively sharing their screen in the meeting
- Check that `mediaTypesFlag: 4` is set (enables screen share)
- Verify webhook is receiving events via ngrok logs

**Only seeing "Skipping small JPEG" messages**
- The shared content may be mostly blank or static
- Try sharing content with more visual complexity

**Webhook not receiving events**
- Verify your ngrok URL is configured in the Zoom App dashboard
- Ensure ZOOM_SECRET_TOKEN matches your Zoom App settings

**Permission errors writing files**
- Ensure the `recordings` directory exists and is writable
- Check file system permissions

## See Also

- [RTMSManager Library Docs](../../library/README.md) - Full API reference
- [Zoom App Setup Guide](../../ZOOM_APP_SETUP.md) - Configure your Zoom app
- [Troubleshooting Guide](../../TROUBLESHOOTING.md) - Common issues

## Docker

The project captures RTMS screen-share frames to local storage. Its multi-stage Dockerfile keeps build tooling out of the final runtime image and does not hard-code a CPU architecture.

Build and run it from the `rtms-samples` repository root:

```bash
docker build -f screen_share/save_screen_share_js/Dockerfile -t rtms-screen_share-save_screen_share_js .
docker run --rm --env-file screen_share/save_screen_share_js/.env -p 3000:3000 rtms-screen_share-save_screen_share_js
```

Run the build from the repository root because the Dockerfile uses repository-relative paths. Runtime secrets are supplied with `--env-file` and are excluded from the image build context. Mount the sample's generated output directory as a volume when recordings must survive container replacement.
