# Zoom RTMS Media Stream to Amazon KVS (Node.js)

This Node.js example receives real-time audio and video from a Zoom meeting through RTMS, muxes both inputs with FFmpeg, and publishes the resulting Matroska stream to **Amazon Kinesis Video Streams (KVS)**. The active implementation uses the KVS PutMedia endpoint directly; an optional module supports the AWS KVS GStreamer plugin.

## Prerequisites

- Node.js v14 or higher
- A Zoom account with RTMS enabled
- Zoom App credentials (Client ID and Client Secret)
- Zoom Secret Token for webhook validation
- An existing AWS KVS stream and AWS credentials available through the standard AWS credential-provider chain
- FFmpeg
- Optional: Linux, GStreamer, and the AWS KVS plugin when using the alternate GStreamer module

### Configuration

- `PORT`: Port for the Express server (default: 3000)
- `ZOOM_SECRET_TOKEN`: Zoom webhook secret token
- `ZOOM_CLIENT_ID`: Zoom client ID
- `ZOOM_CLIENT_SECRET`: Zoom client secret
- `WEBHOOK_PATH`: Webhook route path (default: /webhook)
- `AWS_REGION`: AWS region for KVS
- `AWS_ACCESS_KEY_ID`: Optional AWS access key when not using another credential-provider source
- `AWS_SECRET_ACCESS_KEY`: Optional AWS secret key when not using another credential-provider source
- `STREAM_NAME`: KVS stream that receives the muxed audio and video

## Setup

### 1. Install Node Dependencies
```bash
npm install
```

### 2. Configure `.env`
```
ZOOM_SECRET_TOKEN=your_zoom_secret
ZOOM_CLIENT_ID=your_client_id
ZOOM_CLIENT_SECRET=your_client_secret
PORT=3000
WEBHOOK_PATH=/webhook
AWS_REGION=us-west-2
AWS_ACCESS_KEY_ID=your_aws_access_key
AWS_SECRET_ACCESS_KEY=your_aws_secret_key
STREAM_NAME=zoom-video-stream
```

The AWS key variables can be omitted when credentials are supplied by another standard provider, such as an IAM role or shared AWS profile.

### 3. Optional: Install GStreamer and Dependencies (Ubuntu)
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

## Streaming Implementations

- `kvs_putmedia_producer_stream_audio_and_video_with_ffmpeg.js` is enabled by default. It muxes the RTMS inputs into Matroska and signs a streaming PutMedia request with the AWS SDK credential-provider chain.
- `kvs_gstreamer_stream_audio_and_video_with_ffmpeg.js` is an optional alternative. It muxes the inputs into MPEG-TS and sends that stream through the separately installed `kvssink` plugin. Change the import in `index.js` to select it.


## How it Works

1. The server receives Zoom RTMS webhook events via the `/webhook` endpoint.
2. On `meeting.rtms_started`, it connects to Zoom’s signaling server.
3. After handshake, it connects to the media WebSocket server.
4. Media messages are streamed:
   - **Audio (msg_type 14)** -> FFmpeg audio input
   - **Video (msg_type 15)** -> FFmpeg video input
5. The active producer muxes both tracks and streams them to one KVS stream through PutMedia.
6. On `meeting.rtms_stopped`, the RTMS and producer resources are closed.

## Project Modules

- `kvs_gstreamer_stream_audio_and_video_with_ffmpeg.js`:
   - `startStream()`
   - `sendAudioBuffer(buffer, timestamp)`
   - `sendVideoBuffer(buffer, timestamp)`

- `kvs_putmedia_producer_stream_audio_and_video_with_ffmpeg.js`:
   - `startStream()`
   - `sendAudioBuffer(buffer, timestamp)`
   - `sendVideoBuffer(buffer, timestamp)`

## Kinesis Stream Requirements

- You must pre-create the target stream in KVS.
- Ensure the IAM role has permissions for `kinesisvideo:PutMedia` and `kinesisvideo:GetDataEndpoint`.

## Example Directory Structure
```
.
├── index.js
├── kvs_gstreamer_stream_audio_and_video_with_ffmpeg.js
├── kvs_putmedia_producer_stream_audio_and_video_with_ffmpeg.js
├── .env.example
└── package.json
```

## System Requirements

- Node.js v14 or later
- FFmpeg
- AWS credentials with KVS access
- GStreamer and its AWS plugin only when selecting the optional GStreamer implementation

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
- Select the producer module in `index.js` before starting the sample.
- FFmpeg is required for muxed streaming.
- Audio and video arrive as independent RTMS buffers, then are muxed into one KVS stream.

## Docker

The project passes RTMS media to Amazon Kinesis Video Streams. Its multi-stage Dockerfile keeps build tooling out of the final runtime image and does not hard-code a CPU architecture.

Build and run it from the `rtms-samples` repository root:

```bash
docker build -f streaming/stream_to_aws_kinesis_passthru_js/Dockerfile -t rtms-streaming-stream_to_aws_kinesis_passthru_js .
docker run --rm --env-file streaming/stream_to_aws_kinesis_passthru_js/.env -p 3000:3000 rtms-streaming-stream_to_aws_kinesis_passthru_js
```

Run the build from the repository root because the Dockerfile uses repository-relative paths. Runtime secrets are supplied with `--env-file` and are excluded from the image build context.

The container supports the sample's default AWS PutMedia implementation. The optional `kvssink` implementation requires the Amazon Kinesis Video Streams GStreamer plugin to be built and supplied separately.

## Webhook Delivery Authentication

Normal Zoom webhook deliveries are verified against the exact raw request body using
`x-zm-signature` and `x-zm-request-timestamp`. Configure `ZOOM_SECRET_TOKEN` with the
Marketplace app's webhook Secret Token. Requests with missing, invalid, or stale
signatures are rejected; the default replay window is 300 seconds and can be changed
with `WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS`.
