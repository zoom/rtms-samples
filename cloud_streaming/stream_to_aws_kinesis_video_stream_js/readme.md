
# Zoom RTMS Media Stream to Amazon KVS (Node.js)

This Node.js example demonstrates how to receive real-time audio and video from a Zoom meeting using the RTMS (Real-Time Media Streaming) service and stream them to **Amazon Kinesis Video Streams (KVS)** using GStreamer and the AWS C++ KVS SDK.

## Prerequisites

- Node.js v14 or higher
- A Zoom account with RTMS enabled
- Zoom App credentials (Client ID and Client Secret)
- Zoom Secret Token for webhook validation
- AWS KVS stream names and credentials configured
- Ubuntu Linux recommended for GStreamer + AWS SDK compatibility

### Required Environment Variables

- `PORT`: Port for the Express server (default: 3000)
- `ZOOM_SECRET_TOKEN`: Zoom webhook secret token
- `ZM_CLIENT_ID`: Zoom client ID
- `ZM_CLIENT_SECRET`: Zoom client secret
- `WEBHOOK_PATH`: Webhook route path (default: /webhook)
- `AWS_REGION`: AWS region for KVS
- `AWS_ACCESS_KEY_ID`: AWS access key
- `AWS_SECRET_ACCESS_KEY`: AWS secret key
- `STREAM_NAME`: KVS stream name for video/audio (shared)
- `STREAM_NAME2`: KVS stream name for second media type (audio or video)

## Setup

### 1. Install Node Dependencies
```bash
npm install
```

### 2. Configure `.env`
```
ZOOM_SECRET_TOKEN=your_zoom_secret
ZM_CLIENT_ID=your_client_id
ZM_CLIENT_SECRET=your_client_secret
PORT=3000
WEBHOOK_PATH=/webhook
AWS_REGION=us-west-2
AWS_ACCESS_KEY_ID=your_aws_access_key
AWS_SECRET_ACCESS_KEY=your_aws_secret_key
STREAM_NAME=zoom-video-stream
STREAM_NAME2=zoom-audio-stream
```

### 3. Install GStreamer and Dependencies (Ubuntu)
```bash
sudo apt update
sudo apt install -y \
  git cmake build-essential libssl-dev libcurl4-openssl-dev \
  liblog4cplus-dev libgstreamer1.0-dev libgstreamer-plugins-base1.0-dev \
  gstreamer1.0-tools gstreamer1.0-plugins-base gstreamer1.0-plugins-good \
  gstreamer1.0-plugins-bad gstreamer1.0-plugins-ugly gstreamer1.0-libav
```

### 4. Compile AWS KVS GStreamer Plugin
```bash
cd ~
git clone --recurse-submodules https://github.com/awslabs/amazon-kinesis-video-streams-producer-sdk-cpp.git
cd amazon-kinesis-video-streams-producer-sdk-cpp
mkdir build && cd build
cmake .. -DBUILD_GSTREAMER_PLUGIN=TRUE
make
```

### 5. Configure Environment Variables for GStreamer Plugin
```bash
export GST_PLUGIN_PATH=~/amazon-kinesis-video-streams-producer-sdk-cpp/build
export LD_LIBRARY_PATH=$GST_PLUGIN_PATH:$LD_LIBRARY_PATH
```

Add to `~/.bashrc` if desired.

### 6. Verify KVS Plugin
```bash
gst-inspect-1.0 kvssink
```

## Streaming Options

You can choose one of the two methods to stream to KVS:

### ✅ Option 1: Combined Audio+Video to Single KVS Stream
Uses FFmpeg to mux audio and video into MPEG-TS format, then sends it to KVS.
- Module: `kvs_gstreamer_stream_audio_and_video_with_ffmpeg.js`
- Buffers are muxed and sent together using FFmpeg.

### ✅ Option 2: Separate Streams for Audio and Video
Audio and video are handled independently and sent to separate KVS streams.
- Module: `kvs_gstreamer_split_audio_and_video_to_kvs.js`
- Useful for scenarios where you need individual processing or archiving.

## How it Works

1. The server receives Zoom RTMS webhook events via the `/webhook` endpoint.
2. On `meeting.rtms_started`, it connects to Zoom’s signaling server.
3. After handshake, it connects to the media WebSocket server.
4. Media messages are streamed:
   - **Audio (msg_type 14)** → Audio buffer → GStreamer pipeline → KVS
   - **Video (msg_type 15)** → Video buffer → GStreamer pipeline → KVS
5. On `meeting.rtms_stopped`, all WebSocket connections are gracefully closed.

## Project Modules

- `kvs_gstreamer_stream_audio_and_video_with_ffmpeg.js`:
   - `startStream()`
   - `sendAudioBuffer(buffer, timestamp)`
   - `sendVideoBuffer(buffer, timestamp)`

- `kvs_gstreamer_split_audio_and_video_to_kvs.js`:
   - `startStream()`
   - `sendAudioBuffer(buffer)`
   - `sendVideoBuffer(buffer)`

## Kinesis Stream Requirements

- You must pre-create audio and video streams in KVS.
- Ensure the IAM role has permissions for `kinesisvideo:PutMedia` and `kinesisvideo:GetDataEndpoint`.

## Example Directory Structure
```
.
├── index.js
├── kvs_gstreamer_stream_audio_and_video_with_ffmpeg.js
├── kvs_gstreamer_split_audio_and_video_to_kvs.js
├── .env
└── package.json
```

## System Requirements

- Node.js v14 or later
- GStreamer and its AWS plugin compiled and installed
- Ubuntu (preferred)
- AWS CLI or SDK credentials with access to KVS

## Security Notes

- Do not commit `.env` or any credentials to source control.
- Use HTTPS for production deployments.
- Monitor stream sizes to avoid unnecessary AWS costs.

## Sample GStreamer CLI Test
```bash
gst-launch-1.0 -v \
    videotestsrc is-live=true pattern=ball ! video/x-raw,width=1280,height=720,framerate=30/1 ! \
    x264enc tune=zerolatency bitrate=512 speed-preset=superfast ! h264parse ! \
    kvssink stream-name="TestStream" \
    aws-region="us-west-2" \
    access-key="<ACCESS_KEY>" \
    secret-key="<SECRET_KEY>" \
    storage-size=512
```

## Notes

- This sample streams directly to KVS instead of saving locally or uploading to S3.
- Audio and video can be muxed (Option 1) or streamed separately (Option 2).
- Select the mode that fits your application architecture.
- FFmpeg is required for muxed streaming, but not for separate audio/video mode.
- Audio and video are handled and sent as independent real-time buffers.
