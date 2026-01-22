# Zoom RTMS Object Detection with TensorFlow

This project demonstrates real-time object detection using Zoom RTMS video streams and TensorFlow.js COCO-SSD model. H.264 video frames are decoded using FFmpeg and analyzed for objects.

## Prerequisites

### Environment Variables

Create a `.env` file with the following:

```env
# Zoom Credentials
ZOOM_CLIENT_ID=your_client_id
ZOOM_CLIENT_SECRET=your_client_secret
ZOOM_SECRET_TOKEN=your_secret_token

# Optional
PORT=3000
WEBHOOK_PATH=/webhook
```

### Dependencies

- Node.js v18 or higher
- FFmpeg installed and accessible in PATH

**FFmpeg Installation:**
- macOS: `brew install ffmpeg`
- Ubuntu/Debian: `sudo apt-get install ffmpeg`
- Windows: Download from [FFmpeg website](https://ffmpeg.org/download.html)

## Installation

```bash
npm install
```

Note: First run may take longer as TensorFlow downloads the COCO-SSD model.

## Running the Application

```bash
node index.js
```

The server will start on port 3000 (or the port specified in `.env`).

## How It Works

1. **RTMSManager** handles all Zoom RTMS connection management automatically
2. **WebhookManager** receives Zoom webhook events and forwards them to RTMSManager
3. **H264FrameDecoder** uses FFmpeg to decode H.264 video into JPEG frames (1 frame per second)
4. **TensorFlow COCO-SSD** model detects objects in each decoded frame
5. Detected objects, confidence levels, and timestamps are logged to the console

## Video Parameters

- **Codec**: H.264 (required for continuous stream decoding)
- **Resolution**: HD (720p)
- **FPS**: 25

## Output

Decoded frames and detection results are saved to:
```
recordings/{meeting_uuid}/{user_name}/
├── frame.jpg              # Latest decoded frame
├── frame-{timestamp}.jpg  # Original frame
└── detected-{timestamp}.jpg  # Frame with bounding boxes (when objects detected)
```

## Sample Output

```
📦 Loading COCO-SSD model...
✅ Model loaded.
🔍 [John_Doe] Detected 2 object(s)
🕒 Timestamp (GMT): 2025-01-22T12:30:45.123Z
⏱️  Time drift: 150 ms (0.15 seconds)
#1: person (98.50%)
#2: laptop (87.30%)
```

## Troubleshooting

1. **No detection logs**:
   - Verify FFmpeg is installed: `ffmpeg -version`
   - Check recordings folder for decoded frames
   - Ensure video is enabled in the meeting

2. **Connection issues**:
   - Verify Zoom credentials in `.env`
   - Ensure webhook URL is accessible (use ngrok for local development)

3. **Performance issues**:
   - TensorFlow runs on CPU by default
   - For better performance, consider using a GPU-enabled environment
   - First model load may take 10-20 seconds
