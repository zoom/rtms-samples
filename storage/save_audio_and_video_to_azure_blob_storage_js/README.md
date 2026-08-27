# Save Audio and Video to Azure Blob Storage

Record Zoom meeting audio and video streams and upload them to Azure Blob Storage for cloud storage.

> **Built with [RTMSManager](../../library/README.md)** - Zoom's JavaScript library for real-time media streaming.

## Quick Start

```bash
npm install
cp .env.example .env   # Fill in your credentials
node index.js
```

Expose with ngrok: `ngrok http 3000`

## What This Sample Does

This sample captures real-time audio and video streams from Zoom meetings using RTMS. Media is first saved locally during the meeting, then converted to MP4 using FFmpeg when the meeting ends. The final recordings (.wav, .mp4, .vtt, .srt, .txt files) are automatically uploaded to your Azure Blob Storage container, organized by meeting UUID and stream ID.

## Prerequisites

- Node.js v18+
- Zoom account with RTMS enabled
- FFmpeg installed and accessible in your PATH
- Azure Storage account with blob storage configured
- Azure Storage connection string
- ngrok for local development

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ZOOM_SECRET_TOKEN` | Yes | Secret token for webhook URL validation |
| `ZOOM_CLIENT_ID` | Yes | Zoom OAuth client ID |
| `ZOOM_CLIENT_SECRET` | Yes | Zoom OAuth client secret |
| `AZURE_STORAGE_CONNECTION_STRING` | Yes | Azure Storage connection string (includes AccountName and AccountKey) |
| `PORT` | No | Server port (default: 3000) |
| `WEBHOOK_PATH` | No | Webhook endpoint path (default: `/webhook`) |
| `RTMSTRIGGERMANAGERTYPE` | No | Event trigger type: `webhook` or `websocket` (default: `webhook`) |
| `zoomWSURLForEvents` | No | WebSocket URL for events (required if using websocket mode) |
| `ZOOM_S2S_CLIENT_ID` | No | Server-to-server OAuth client ID |
| `ZOOM_S2S_CLIENT_SECRET` | No | Server-to-server OAuth client secret |
| `ZOOM_ACCOUNT_ID` | No | Zoom account ID for S2S OAuth |
| `VIDEO_CLIENT_ID` | No | Video SDK client ID (for Video SDK events) |
| `VIDEO_CLIENT_SECRET` | No | Video SDK client secret |
| `VIDEO_SECRET_TOKEN` | No | Video SDK webhook secret token |
| `MEDIA_SOCKET_CONNECTION_MODE` | No | Socket mode: `split` or `combined` (default: `split`) |
| `MEDIA_TYPES_FLAG` | No | Media types bitmask: 1=audio, 2=video, 3=both (default: `3`) |

## Code Walkthrough

### 1. Initialize RTMSManager

```javascript
const rtmsConfig = {
  logging: process.env.LOG_LEVEL || 'info',
  logDir: path.join(__dirname, 'logs'),
  mediaSocketConnectionMode: process.env.MEDIA_SOCKET_CONNECTION_MODE || 'split',
  mediaTypesFlag: parseInt(process.env.MEDIA_TYPES_FLAG || '3'),
  credentials: {
    meeting: {
      clientId: process.env.ZOOM_CLIENT_ID,
      clientSecret: process.env.ZOOM_CLIENT_SECRET,
      zoomSecretToken: process.env.ZOOM_SECRET_TOKEN,
    },
    video: {
      videoClientId: process.env.VIDEO_CLIENT_ID,
      videoClientSecret: process.env.VIDEO_CLIENT_SECRET,
      videoSecretToken: process.env.VIDEO_SECRET_TOKEN,
    },
    s2s: s2sCredentials,
    websocket: websocketCredentials
  },
  mediaParams: {
    audio: {
      contentType: MEDIA_PARAMS.MEDIA_CONTENT_TYPE_RAW_AUDIO,
      sampleRate: MEDIA_PARAMS.AUDIO_SAMPLE_RATE_SR_16K,
      channel: MEDIA_PARAMS.AUDIO_CHANNEL_MONO,
      codec: MEDIA_PARAMS.MEDIA_PAYLOAD_TYPE_L16,
      dataOpt: MEDIA_PARAMS.MEDIA_DATA_OPTION_AUDIO_MIXED_STREAM,
      sendRate: 20,
    },
    video: {
      contentType: MEDIA_PARAMS.MEDIA_CONTENT_TYPE_RAW_VIDEO,
      codec: MEDIA_PARAMS.MEDIA_PAYLOAD_TYPE_H264,
      dataOpt: MEDIA_PARAMS.MEDIA_DATA_OPTION_VIDEO_SINGLE_ACTIVE_STREAM,
      resolution: MEDIA_PARAMS.MEDIA_RESOLUTION_HD,
      fps: 25,
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
    videoSecretToken: rtmsConfig.credentials.video?.videoSecretToken
  },
  app: app
});

webhookManager.on('event', (event, payload) => {
  console.log('[Consumer] Webhook Event:', event, payload);
  RTMSManager.handleEvent(event, payload);
});

webhookManager.setup();
```

### 3. Handle Media Events

```javascript
RTMSManager.on('audio', ({ buffer, userId, userName, timestamp, meetingId, streamId, productType }) => {
  HelperManager.audio.saveRawAudio(buffer, meetingId, 'mixed', timestamp, streamId, true);
});

RTMSManager.on('video', ({ buffer, userId, userName, timestamp, meetingId, streamId, productType }) => {
  if (!meetingState.has(meetingId)) {
    const videoFiller = new VideoGapFiller({ fps: 25, gapThreshold: 320 });
    
    videoFiller.on('data', ({ buffer: videoBuffer, timestamp: ts, isFiller }) => {
      HelperManager.video.saveRawVideo(videoBuffer, 'mixed', ts, meetingId, streamId, true);
    });
    
    videoFiller.start();
    meetingState.set(meetingId, { videoFiller, streamId });
  }
  
  meetingState.get(meetingId).videoFiller.push(buffer, timestamp);
});

RTMSManager.on('meeting.rtms_stopped', async (payload) => {
  const { meeting_uuid, rtms_stream_id } = payload;

  const state = meetingState.get(meeting_uuid);
  if (state) {
    state.videoFiller.stop();
    meetingState.delete(meeting_uuid);
  }

  setTimeout(async () => {
    await HelperManager.audiovideo.convertMeetingMedia(meeting_uuid, rtms_stream_id);
    await HelperManager.audiovideo.muxMixedAudioVideo(meeting_uuid, rtms_stream_id);

    try {
      await saveToAzure(meeting_uuid, rtms_stream_id);
      console.log(`[Consumer] Azure upload complete for meeting ${meeting_uuid}`);
    } catch (error) {
      console.error(`[Consumer] Azure upload failed for meeting ${meeting_uuid}:`, error.message);
      console.log(`[Consumer] Files are still available locally in recordings/`);
    }
  }, 2000);
});
```

### 4. Start the Server

```javascript
await RTMSManager.start();

server.listen(appConfig.port, () => {
  console.log(`[Consumer] Server listening on port ${appConfig.port}`);
});
```

## Key Files

| File | Purpose |
|------|---------|
| `index.js` | Main application entry point with RTMS setup and media handlers |
| `AzureStorageHelper.js` | Azure Blob Storage upload logic with content-type detection |

## How It Works

1. The server starts and initializes RTMSManager with audio/video configuration
2. WebhookManager listens for Zoom RTMS events at the configured endpoint
3. When a meeting starts, RTMS connection is established automatically
4. Audio chunks are saved to raw files using `HelperManager.audio.saveRawAudio()`
5. Video frames pass through `VideoGapFiller` to handle timing gaps, then saved via `HelperManager.video.saveRawVideo()`
6. When the meeting ends (`meeting.rtms_stopped`), FFmpeg converts and muxes audio/video into MP4
7. The `saveToAzure()` function uploads all finalized files (.wav, .mp4, .vtt, .srt, .txt) to Azure Blob Storage
8. Files are stored in the `rtms` container at `{meetingUuid}/{streamId}/{filename}`

## Troubleshooting

**No audio/video files generated**
- Verify FFmpeg is installed: `ffmpeg -version`
- Check that the `recordings/` folder exists
- Ensure your Zoom app has RTMS scopes enabled

**Azure upload failures**
- Verify `AZURE_STORAGE_CONNECTION_STRING` contains valid AccountName and AccountKey
- Check that your storage account allows blob access
- Ensure network connectivity to Azure Storage endpoints
- Files remain available locally in `recordings/` if upload fails

**Authentication errors**
- Double-check the AccountKey in your connection string
- Verify the storage account name is correct
- Ensure the connection string format is valid

**Connection issues**
- Verify ngrok is running and the tunnel URL matches your Zoom app webhook configuration
- Check that credentials in `.env` match your Zoom app settings
- Ensure the webhook endpoint is publicly accessible

**Empty or corrupted recordings**
- This may occur with very short meetings or if the stream was interrupted
- Check the `logs/` folder for detailed error messages

## See Also

- [RTMSManager Library Docs](../../library/README.md) - Full API reference
- [Zoom App Setup Guide](../../ZOOM_APP_SETUP.md) - Configure your Zoom app
- [Troubleshooting Guide](../../TROUBLESHOOTING.md) - Common issues

## Docker

The project stores RTMS audio and video recordings in Azure Blob Storage. Its multi-stage Dockerfile keeps build tooling out of the final runtime image and does not hard-code a CPU architecture.

Build and run it from the `rtms-samples` repository root:

```bash
docker build -f storage/save_audio_and_video_to_azure_blob_storage_js/Dockerfile -t rtms-storage-save_audio_and_video_to_azure_blob_storage_js .
docker run --rm --env-file storage/save_audio_and_video_to_azure_blob_storage_js/.env -p 3000:3000 rtms-storage-save_audio_and_video_to_azure_blob_storage_js
```

Run the build from the repository root because the Dockerfile uses repository-relative paths. Runtime secrets are supplied with `--env-file` and are excluded from the image build context.
