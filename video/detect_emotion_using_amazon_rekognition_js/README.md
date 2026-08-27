# Detect Emotions Using Amazon Rekognition

Analyze participant emotions in real-time during Zoom meetings using AWS Rekognition facial analysis.

> **Built with [RTMSManager](../../library/README.md)** - Zoom's JavaScript library for real-time media streaming.

## Quick Start

```bash
npm install
cp .env.example .env   # Fill in your credentials
node index.js
```

Expose with ngrok: `ngrok http 3000`

## What This Sample Does

This sample captures video frames from Zoom meeting participants and analyzes them using Amazon Rekognition's facial analysis API. It detects emotions such as happiness, sadness, anger, surprise, and more for each face in the frame. To optimize API usage and costs, it processes only every Nth frame (configurable via environment variable).

## Prerequisites

- Node.js v18+
- Zoom account with RTMS enabled
- AWS account with Rekognition access
- AWS credentials (Access Key ID and Secret Access Key)
- ngrok for local development

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| ZOOM_SECRET_TOKEN | Yes | Zoom webhook secret token for verification |
| ZOOM_CLIENT_ID | Yes | Zoom app client ID |
| ZOOM_CLIENT_SECRET | Yes | Zoom app client secret |
| PORT | No | Server port (default: 3000) |
| WEBHOOK_PATH | No | Webhook endpoint path (default: /webhook) |
| AWS_REGION | Yes | AWS region for Rekognition (e.g., us-east-1) |
| AWS_ACCESS_KEY_ID | Yes | AWS access key ID |
| AWS_SECRET_ACCESS_KEY | Yes | AWS secret access key |
| PROCESS_EVERY_N_FRAMES | No | Process every Nth frame (default: 50) |

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
      codec: MEDIA_PARAMS.MEDIA_PAYLOAD_TYPE_JPG,
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
  console.log('[detect_emotion] Webhook Event:', event);
  RTMSManager.handleEvent(event, payload);
});

webhookManager.setup();
```

### 3. Handle Video Events

```javascript
RTMSManager.on('video', async (payload) => {
  const { buffer, userId, userName, timestamp } = payload;
  frameCounter++;

  if (frameCounter % PROCESS_EVERY_N_FRAMES === 0) {
    try {
      const emotions = await detectEmotions(buffer);
      if (emotions.length > 0) {
        console.log(`[detect_emotion] Frame ${frameCounter} - User: ${userName || userId}`);
        console.log(JSON.stringify(emotions, null, 2));
      }
    } catch (err) {
      console.error(`[detect_emotion] Error on frame ${frameCounter}:`, err.message);
    }
  }
});
```

### 4. Start the Server

```javascript
await RTMSManager.start();

server.listen(appConfig.port, () => {
  console.log(`[detect_emotion] Server listening on port ${appConfig.port}`);
  console.log(`[detect_emotion] Webhook endpoint: http://localhost:${appConfig.port}${process.env.WEBHOOK_PATH || '/webhook'}`);
});
```

## Key Files

| File | Purpose |
|------|---------|
| index.js | Main application entry point with RTMSManager setup and video event handling |
| amazonRekognition.js | AWS Rekognition integration for emotion detection |
| .env.example | Template for environment variables |

## How It Works

1. The server starts and initializes RTMSManager with video configuration (JPEG codec, HD resolution)
2. When a Zoom meeting starts RTMS streaming, the webhook receives the event
3. RTMSManager establishes a WebSocket connection and receives video frames
4. Every Nth frame (default: 50) is sent to Amazon Rekognition for facial analysis
5. Rekognition returns detected faces with emotion scores (happiness, sadness, anger, etc.)
6. Results are logged to the console with user identification and confidence scores

## Troubleshooting

**"Missing AWS_REGION in .env" error**
- Ensure your `.env` file contains a valid `AWS_REGION` value (e.g., `us-east-1`)

**No emotions detected**
- Verify the video codec is set to JPG (`MEDIA_PAYLOAD_TYPE_JPG`)
- Check that participants have their cameras enabled
- Ensure faces are visible and well-lit in the video

**High API costs**
- Increase `PROCESS_EVERY_N_FRAMES` to reduce the number of Rekognition API calls
- Default is 50, meaning only 1 in 50 frames is analyzed

**AWS authentication errors**
- Verify your AWS credentials are correct in `.env`
- Ensure your IAM user has `rekognition:DetectFaces` permission

## See Also

- [RTMSManager Library Docs](../../library/README.md) - Full API reference
- [Zoom App Setup Guide](../../ZOOM_APP_SETUP.md) - Configure your Zoom app
- [Troubleshooting Guide](../../TROUBLESHOOTING.md) - Common issues

## Docker

The project analyzes RTMS video frames with Amazon Rekognition. Its multi-stage Dockerfile keeps build tooling out of the final runtime image and does not hard-code a CPU architecture.

Build and run it from the `rtms-samples` repository root:

```bash
docker build -f video/detect_emotion_using_amazon_rekognition_js/Dockerfile -t rtms-video-detect_emotion_using_amazon_rekognition_js .
docker run --rm --env-file video/detect_emotion_using_amazon_rekognition_js/.env -p 3000:3000 rtms-video-detect_emotion_using_amazon_rekognition_js
```

Run the build from the repository root because the Dockerfile uses repository-relative paths. Runtime secrets are supplied with `--env-file` and are excluded from the image build context.
