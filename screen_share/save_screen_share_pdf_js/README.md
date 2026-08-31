# Save Screen Share to PDF

Captures Zoom screen share streams, detects unique frames, and generates a PDF document.

> **Built with [RTMSManager](../../library/README.md)** - Zoom's JavaScript library for real-time media streaming.

## Quick Start

```bash
npm install
cp .env.example .env   # Fill in your credentials
node index.js
```

Expose with ngrok: `ngrok http 3000`

## What This Sample Does

This sample connects to Zoom's Real-Time Media Streaming (RTMS) API and intelligently captures screen share content. Unlike basic frame capture, it uses pixel-level comparison to detect only unique frames when the shared screen content actually changes. When the RTMS session ends, it automatically generates a PDF document containing all unique frames along with a text file listing timestamps for each page.

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
      resolution: MEDIA_PARAMS.MEDIA_RESOLUTION_FHD,
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
  console.log('[save_screen_share_pdf] Webhook Event:', event);
  RTMSManager.handleEvent(event, payload);
});

webhookManager.setup();
```

### 3. Handle Screen Share Events

```javascript
RTMSManager.on('sharescreen', async (payload) => {
  const { buffer, userId, timestamp, meetingId } = payload;
  await handleShareData(buffer, userId, timestamp, meetingId);
});

RTMSManager.on('meeting.rtms_started', (payload) => {
  console.log('[save_screen_share_pdf] RTMS Started:', payload.meeting_uuid);
});

RTMSManager.on('meeting.rtms_stopped', async (payload) => {
  console.log('[save_screen_share_pdf] RTMS Stopped:', payload.meeting_uuid);
  await generatePDFAndText(payload.meeting_uuid);
});
```

### 4. Start the Server

```javascript
await RTMSManager.start();

server.listen(appConfig.port, () => {
  console.log(`[save_screen_share_pdf] Server listening on port ${appConfig.port}`);
  console.log(`[save_screen_share_pdf] Webhook endpoint: http://localhost:${appConfig.port}${process.env.WEBHOOK_PATH || '/webhook'}`);
});
```

## Key Files

| File | Purpose |
|------|---------|
| `index.js` | Main entry point - initializes RTMSManager, sets up webhooks and event handlers |
| `saveSharescreen.js` | Handles frame comparison, uniqueness detection, and PDF generation |
| `.env.example` | Template for environment variables |
| `package.json` | Project dependencies (includes sharp, pixelmatch, pdfkit) |

## How It Works

1. The application starts an Express server and initializes RTMSManager with FHD screen share configuration
2. WebhookManager listens for Zoom webhook events and forwards them to RTMSManager
3. Each meeting maintains a session with a frame counter and last accepted frame buffer
4. Screen share frames arrive via the `sharescreen` event as JPEG binary buffers
5. The `handleShareData` function uses `sharp` to convert frames to RGBA for comparison
6. `pixelmatch` compares the current frame against the last accepted frame at the pixel level
7. Frames with more than 1% pixel difference are considered unique and saved
8. Unique frames are stored in `recordings/{meetingId}/processed/jpg/unique_{n}.jpg`
9. When RTMS stops, `generatePDFAndText` creates a PDF and timestamp file from all unique frames
10. Output files are saved to `recordings/{meetingId}/processed/approved.pdf` and `frames.txt`

## Troubleshooting

**No PDF generated**
- PDF is only generated when RTMS session stops (meeting ends or streaming stops)
- Ensure at least one unique frame was captured during the session
- Check the `recordings/{meetingId}/processed/jpg/` folder for saved frames

**Too many frames being saved**
- The 1% difference threshold may be too sensitive for your content
- Consider adjusting the `diffRatio > 0.01` threshold in `saveSharescreen.js`

**All frames being skipped as "similar"**
- The shared content may not be changing significantly
- Try sharing a presentation and advancing slides

**Webhook not receiving events**
- Verify your ngrok URL is configured in the Zoom App dashboard
- Ensure ZOOM_SECRET_TOKEN matches your Zoom App settings

**Sharp installation errors**
- Sharp requires native dependencies; ensure you have build tools installed
- On Linux: `apt-get install build-essential`
- On macOS: `xcode-select --install`

## See Also

- [RTMSManager Library Docs](../../library/README.md) - Full API reference
- [Zoom App Setup Guide](../../ZOOM_APP_SETUP.md) - Configure your Zoom app
- [Troubleshooting Guide](../../TROUBLESHOOTING.md) - Common issues

## Docker

The project captures RTMS screen-share frames and assembles them into PDF output. Its multi-stage Dockerfile keeps build tooling out of the final runtime image and does not hard-code a CPU architecture.

Build and run it from the `rtms-samples` repository root:

```bash
docker build -f screen_share/save_screen_share_pdf_js/Dockerfile -t rtms-screen_share-save_screen_share_pdf_js .
docker run --rm --env-file screen_share/save_screen_share_pdf_js/.env -p 3000:3000 rtms-screen_share-save_screen_share_pdf_js
```

Run the build from the repository root because the Dockerfile uses repository-relative paths. Runtime secrets are supplied with `--env-file` and are excluded from the image build context. Mount the sample's generated output directory as a volume when recordings must survive container replacement.

## Webhook Delivery Authentication

Normal Zoom webhook deliveries are verified against the exact raw request body using
`x-zm-signature` and `x-zm-request-timestamp`. Configure `ZOOM_SECRET_TOKEN` with the
Marketplace app's webhook Secret Token. Requests with missing, invalid, or stale
signatures are rejected; the default replay window is 300 seconds and can be changed
with `WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS`.
