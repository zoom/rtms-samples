# Detect Objects Using TensorFlow.js

Detect and classify objects in real-time video streams from Zoom meetings using TensorFlow.js COCO-SSD model.

> **Built with [RTMSManager](../../library/README.md)** - Zoom's JavaScript library for real-time media streaming.

## Quick Start

```bash
npm install
cp .env.example .env   # Fill in your credentials
node index.js
```

Expose with ngrok: `ngrok http 3000`

## What This Sample Does

This sample receives H.264 encoded video from Zoom meeting participants, decodes frames using FFmpeg, and runs object detection using TensorFlow.js with the COCO-SSD model. It can detect 80 common object categories including people, cars, phones, laptops, and more. Detected objects are logged with confidence scores and optional annotated images are saved to disk.

## Prerequisites

- Node.js v18+
- Zoom account with RTMS enabled
- FFmpeg installed and available in PATH
- ngrok for local development

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| ZOOM_SECRET_TOKEN | Yes | Zoom webhook secret token for verification |
| ZOOM_CLIENT_ID | Yes | Zoom app client ID |
| ZOOM_CLIENT_SECRET | Yes | Zoom app client secret |
| PORT | No | Server port (default: 3000) |
| WEBHOOK_PATH | No | Webhook endpoint path (default: /webhook) |

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
  mediaTypesFlag: 2,
  credentials: {
    meeting: {
      clientId: process.env.ZOOM_CLIENT_ID,
      clientSecret: process.env.ZOOM_CLIENT_SECRET,
      zoomSecretToken: process.env.ZOOM_SECRET_TOKEN,
    }
  },
  mediaParams: {
    video: {
      codec: MEDIA_PARAMS.MEDIA_PAYLOAD_TYPE_H264,
      resolution: MEDIA_PARAMS.MEDIA_RESOLUTION_HD,
      fps: 25,
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
  console.log('[detect_object] Webhook Event:', event);
  RTMSManager.handleEvent(event, payload);
});

webhookManager.setup();
```

### 3. Handle Video Events

```javascript
RTMSManager.on('video', (payload) => {
  const { buffer, userId, userName, timestamp, meetingId } = payload;

  const safeUserName = userName ? sanitizeFileName(userName) : 'default-view';
  const safeMeetingUuid = sanitizeFileName(meetingId);
  const outputDir = path.join(__dirname, 'recordings', safeMeetingUuid);
  fs.mkdirSync(outputDir, { recursive: true });

  if (!decoderMap.has(safeUserName)) {
    const decoder = new H264FrameDecoder(outputDir, (imagePath, metadata) => {
      const imgBuffer = fs.readFileSync(imagePath);
      tensorFlowDetectObject(imgBuffer, safeUserName, metadata.timestamp, safeMeetingUuid, false);
    });
    decoderMap.set(safeUserName, decoder);
  }

  decoderMap.get(safeUserName).writeChunk(buffer, { timestamp });
});
```

### 4. Start the Server

```javascript
await RTMSManager.start();

server.listen(appConfig.port, () => {
  console.log(`[detect_object] Server listening on port ${appConfig.port}`);
  console.log(`[detect_object] Webhook endpoint: http://localhost:${appConfig.port}${process.env.WEBHOOK_PATH || '/webhook'}`);
});
```

## Key Files

| File | Purpose |
|------|---------|
| index.js | Main application entry point with RTMSManager setup and video event handling |
| tensorFlowDetectObject.js | TensorFlow.js COCO-SSD object detection implementation |
| ffmpegFrameDecoder.js | H.264 to JPEG frame decoder using FFmpeg |
| .env.example | Template for environment variables |

## How It Works

1. The server starts and initializes RTMSManager with H.264 video configuration
2. When a Zoom meeting starts RTMS streaming, the webhook receives the event
3. RTMSManager establishes a WebSocket connection and receives H.264 video chunks
4. Each participant's video stream is piped to a dedicated FFmpeg decoder process
5. FFmpeg extracts frames at 1 FPS and saves them as JPEG images
6. The TensorFlow.js COCO-SSD model analyzes each frame for objects
7. Detected objects are logged with class name, confidence score, and bounding box
8. Optionally, annotated images with bounding boxes are saved to the recordings directory

## Troubleshooting

**"FFmpeg not found" or spawn errors**
- Ensure FFmpeg is installed: `ffmpeg -version`
- On Ubuntu/Debian: `sudo apt install ffmpeg`
- On macOS: `brew install ffmpeg`

**"Model loading" takes too long**
- The COCO-SSD model downloads on first run (~5MB)
- Subsequent runs use the cached model

**No objects detected**
- Verify FFmpeg is producing frames in the `recordings/` directory
- Check that the `frame.jpg` file is being created
- Ensure participants have their cameras enabled

**High CPU usage**
- TensorFlow.js runs inference on CPU by default
- Consider using `@tensorflow/tfjs-node-gpu` for GPU acceleration
- Reduce frame rate in FFmpeg decoder (currently set to 1 FPS)

**Memory issues with multiple participants**
- Each participant has a dedicated FFmpeg decoder process
- Monitor memory usage with many concurrent participants
- Decoders are cleaned up when RTMS stops

## See Also

- [RTMSManager Library Docs](../../library/README.md) - Full API reference
- [Zoom App Setup Guide](../../ZOOM_APP_SETUP.md) - Configure your Zoom app
- [Troubleshooting Guide](../../TROUBLESHOOTING.md) - Common issues

## Docker

The project analyzes RTMS video frames locally with TensorFlow COCO-SSD. Its multi-stage Dockerfile keeps build tooling out of the final runtime image and does not hard-code a CPU architecture.

Build and run it from the `rtms-samples` repository root:

```bash
docker build -f video/detect_object_using_tensorflow_js/Dockerfile -t rtms-video-detect_object_using_tensorflow_js .
docker run --rm --env-file video/detect_object_using_tensorflow_js/.env -p 3000:3000 rtms-video-detect_object_using_tensorflow_js
```

Run the build from the repository root because the Dockerfile uses repository-relative paths. Runtime secrets are supplied with `--env-file` and are excluded from the image build context.

## Webhook Delivery Authentication

Normal Zoom webhook deliveries are verified against the exact raw request body using
`x-zm-signature` and `x-zm-request-timestamp`. Configure `ZOOM_SECRET_TOKEN` with the
Marketplace app's webhook Secret Token. Requests with missing, invalid, or stale
signatures are rejected; the default replay window is 300 seconds and can be changed
with `WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS`.
