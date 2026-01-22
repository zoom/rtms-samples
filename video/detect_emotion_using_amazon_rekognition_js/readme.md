# Zoom RTMS Emotion Detection with Amazon Rekognition

This project demonstrates real-time emotion detection using Zoom RTMS video streams and Amazon Rekognition. Video frames are sampled and analyzed for facial emotions, with results printed to the console.

## Prerequisites

### Environment Variables

Create a `.env` file with the following:

```env
# Zoom Credentials
ZOOM_CLIENT_ID=your_client_id
ZOOM_CLIENT_SECRET=your_client_secret
ZOOM_SECRET_TOKEN=your_secret_token

# AWS Credentials
AWS_ACCESS_KEY_ID=your_aws_access_key
AWS_SECRET_ACCESS_KEY=your_aws_secret_key
AWS_REGION=us-east-1

# Optional
PORT=3000
WEBHOOK_PATH=/webhook
PROCESS_EVERY_N_FRAMES=50
```

### Dependencies

- Node.js v18 or higher
- AWS account with Rekognition access

## Installation

```bash
npm install
```

## Running the Application

```bash
node index.js
```

The server will start on port 3000 (or the port specified in `.env`).

## How It Works

1. **RTMSManager** handles all Zoom RTMS connection management automatically
2. **WebhookManager** receives Zoom webhook events and forwards them to RTMSManager
3. Every Nth video frame (default: 50) is sent to Amazon Rekognition for emotion analysis
4. Detected emotions and confidence levels are logged to the console

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3000 | Server port |
| `WEBHOOK_PATH` | /webhook | Webhook endpoint path |
| `PROCESS_EVERY_N_FRAMES` | 50 | Process every Nth frame for emotion detection |

## Video Parameters

- **Codec**: JPEG (optimized for image analysis)
- **Resolution**: HD (720p)
- **FPS**: 25

## Sample Output

```
[detect_emotion] Frame 50 - User: John Doe
[
  {
    "BoundingBox": { "Width": 0.25, "Height": 0.35, "Left": 0.3, "Top": 0.2 },
    "Emotions": [
      { "Type": "HAPPY", "Confidence": 95.5 },
      { "Type": "CALM", "Confidence": 4.2 }
    ]
  }
]
```

## Troubleshooting

1. **No emotion data**:
   - Verify AWS credentials are correct
   - Ensure AWS_REGION is set
   - Check that faces are visible in the video

2. **Connection issues**:
   - Verify Zoom credentials in `.env`
   - Ensure webhook URL is accessible (use ngrok for local development)

3. **AWS errors**:
   - Verify IAM permissions for Rekognition
   - Check AWS region supports Rekognition
