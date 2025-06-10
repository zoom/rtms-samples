# Manual Workaround (Temporary)

> ⚠️ **Note:** This workaround is temporary. The documentation is being updated, and this process will be simplified in the near future.

Follow these steps to get the app running manually for now:

1. Ensure CMake version **3.25.1** is installed on your development machine.  
   - This guide assumes Ubuntu, but macOS should be similar.

2. Clone the developer preview app:
   ```bash
   git clone https://github.com/zoom/rtms-developer-preview-js
   ```

3. Inside that directory, manually create the following folder:
   ```bash
   mkdir -p node_modules/@zoom
   ```

4. Navigate into the new folder and clone the SDK:
   ```bash
   cd node_modules/@zoom
   git clone https://github.com/zoom/rtms
   ```

5. Compile the SDK:
   ```bash
   cd rtms
   npm install
   ```

6. Go back to the root of the developer preview app and start it:
   ```bash
   cd ../../../
   node index.js
   ```

---

# RTMS Developer Preview Tester App

This simple app demonstrates integration with the Zoom Realtime Media Streams SDK for Node.js.

> [!IMPORTANT]
> **Confidential under NDA - Do not distribute during developer preview**<br />
> This document contains confidential information that requires an NDA. It is intended only for partners in the Zoom RTMS developer preview.
> Participation in the RTMS Developer Preview, including access to and use of these materials, is subject to [Zoom's Beta Program - Terms of Use](https://www.zoom.com/en/trust/beta-terms-and-conditions/).

## Setup

Install the SDK from GitHub:

```bash
npm install github:zoom/rtms
```

### Developer Preview Only 

The Node.js SDK requires prebuilt binaries from the underlying C SDK:

```bash
npm run fetch -- your-token-goes-here
```

## Configuration

Copy the example environment file and fill in your credentials:

```bash
cp .env.example .env
```

## Running the App

Start the application:

```bash
npm start
```

## Using with Zoom Webhooks

To receive webhooks from Zoom, expose your local server using ngrok:

```bash
ngrok http 8080
```

Use the generated ngrok URL as your Zoom Marketplace webhook endpoint.

## Media Parameter Configuration

The SDK provides detailed control over audio and video processing. Use these parameters with `setAudioParameters()` and `setVideoParameters()` to match the naming scheme in our documentation:

### Audio Parameters

```javascript
client.setAudioParameters({
  contentType: rtms.AudioContentType.RAW_AUDIO,
  codec: rtms.AudioCodec.OPUS,
  sampleRate: 16000,
  channel: rtms.AudioChannel.MONO,
  dataOpt: rtms.AudioDataOption.AUDIO_MIXED_STREAM,
  duration: 20,
  frameSize: 320
});
```

### Video Parameters

```javascript
client.setVideoParameters({
  contentType: rtms.VideoContentType.RAW_VIDEO,
  codec: rtms.VideoCodec.H264,
  resolution: rtms.VideoResolution.HD,
  dataOpt: rtms.VideoDataOption.VIDEO_MIXED_GALLERY_VIEW,
  fps: 30
});
```

### Available Options

#### Audio
- **ContentType**: UNDEFINED, RTP, RAW_AUDIO, FILE_STREAM, TEXT
- **Codec**: UNDEFINED, L16, G711, G722, OPUS
- **SampleRate**: SR_8K, SR_16K, SR_32K, SR_48K
- **Channel**: MONO, STEREO
- **DataOption**: UNDEFINED, AUDIO_MIXED_STREAM, AUDIO_MULTI_STREAMS

#### Video
- **ContentType**: UNDEFINED, RTP, RAW_VIDEO, FILE_STREAM, TEXT
- **Codec**: UNDEFINED, JPG, PNG, H264
- **Resolution**: SD, HD, FHD, QHD
- **DataOption**: UNDEFINED, VIDEO_SINGLE_ACTIVE_STREAM, VIDEO_MIXED_SPEAKER_VIEW, VIDEO_MIXED_GALLERY_VIEW
