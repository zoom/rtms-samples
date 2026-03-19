# Media Parameters

Complete reference for RTMS media configuration options. These values are used in the `media_params` object during the media handshake.

> **Official Documentation**: [Media Parameter Definitions](https://developers.zoom.us/docs/rtms/media-parameter-definition/) | [Data Types](https://developers.zoom.us/docs/rtms/data-types/)

## Media Content Type

Specifies the format of media data transmission.

| Constant | Value | Description |
|----------|-------|-------------|
| `MEDIA_CONTENT_TYPE_RAW_AUDIO` | 2 | Raw audio samples without headers |
| `MEDIA_CONTENT_TYPE_RAW_VIDEO` | 3 | Raw video frames without headers |
| `MEDIA_CONTENT_TYPE_FILE_STREAM` | 4 | File stream format |
| `MEDIA_CONTENT_TYPE_TEXT` | 5 | Plain text (for transcript/chat) |

`MEDIA_CONTENT_TYPE_RTP` is retained in the helper libraries only as a deprecated compatibility alias that now maps to `2`. New payloads should use `MEDIA_CONTENT_TYPE_RAW_AUDIO`.

## Media Data Type (Bitmask)

Used in the `media_type` field to specify which media streams to receive. Values can be combined using bitwise OR.

| Constant | Value | Description |
|----------|-------|-------------|
| `MEDIA_DATA_TYPE_AUDIO` | 1 | Audio stream |
| `MEDIA_DATA_TYPE_VIDEO` | 2 | Video stream |
| `MEDIA_DATA_TYPE_DESKSHARE` | 4 | Screen share stream |
| `MEDIA_DATA_TYPE_TRANSCRIPT` | 8 | Real-time transcript |
| `MEDIA_DATA_TYPE_CHAT` | 16 | Chat messages |
| `MEDIA_DATA_TYPE_ALL` | 32 | All media types |

**Example**: To receive only audio and transcript: `media_type = 1 | 8` = `9`

## Audio Parameters

### Sample Rate

| Constant | Value | Rate |
|----------|-------|------|
| `AUDIO_SAMPLE_RATE_SR_8K` | 0 | 8,000 Hz |
| `AUDIO_SAMPLE_RATE_SR_16K` | 1 | 16,000 Hz |
| `AUDIO_SAMPLE_RATE_SR_32K` | 2 | 32,000 Hz |
| `AUDIO_SAMPLE_RATE_SR_48K` | 3 | 48,000 Hz |

### Channel

| Constant | Value | Description |
|----------|-------|-------------|
| `AUDIO_CHANNEL_MONO` | 1 | Single channel |
| `AUDIO_CHANNEL_STEREO` | 2 | Dual channel (Opus codec only) |

> **Note**: Stereo is currently only supported with the Opus codec (`MEDIA_PAYLOAD_TYPE_OPUS`). Other codecs (L16, G711, G722) support mono only.

### Audio Codec (Payload Type)

| Constant | Value | Description |
|----------|-------|-------------|
| `MEDIA_PAYLOAD_TYPE_L16` | 1 | Linear PCM 16-bit (uncompressed) |
| `MEDIA_PAYLOAD_TYPE_G711` | 2 | G.711 A-law only |
| `MEDIA_PAYLOAD_TYPE_G722` | 3 | G.722 codec |
| `MEDIA_PAYLOAD_TYPE_OPUS` | 4 | Opus codec (compressed, supports stereo) |

### Audio Data Option

| Constant | Value | Description |
|----------|-------|-------------|
| `MEDIA_DATA_OPTION_AUDIO_MIXED_STREAM` | 1 | Single mixed audio stream (all participants combined) |
| `MEDIA_DATA_OPTION_AUDIO_MULTI_STREAMS` | 2 | Separate audio stream per participant |

### Send Rate

The `send_rate` parameter specifies the interval (in milliseconds) between audio packets.

| Value | Description |
|-------|-------------|
| `20` | **Recommended.** 20ms intervals provide optimal balance of latency and efficiency. |

## Video Parameters

### Video Codec (Payload Type)

| Constant | Value | Description |
|----------|-------|-------------|
| `MEDIA_PAYLOAD_TYPE_H264` | 7 | H.264 video codec |

### Resolution

| Constant | Value | Resolution |
|----------|-------|------------|
| `MEDIA_RESOLUTION_SD` | 1 | 640×360 (360p) or 640×480 (480p) |
| `MEDIA_RESOLUTION_HD` | 2 | 1280×720 (720p) |
| `MEDIA_RESOLUTION_FHD` | 3 | 1920×1080 (1080p) |
| `MEDIA_RESOLUTION_QHD` | 4 | 2560×1440 (2K) |

### Video Data Option

| Constant | Value | Description |
|----------|-------|-------------|
| `MEDIA_DATA_OPTION_VIDEO_SINGLE_ACTIVE_STREAM` | 3 | Single stream of current active speaker |
| `MEDIA_DATA_OPTION_VIDEO_MIXED_SPEAKER_VIEW` | 4 | Mixed stream in speaker view layout |
| `MEDIA_DATA_OPTION_VIDEO_MIXED_GALLERY_VIEW` | 5 | Mixed stream in gallery view layout |

### FPS

Configurable from 1-30 frames per second. Common values:
- `1` - For screen share/slides (low motion)
- `15` - Balanced quality/bandwidth
- `25` - Standard video
- `30` - High quality video

## Screen Share Parameters

### Screen Share Codec (Payload Type)

| Constant | Value | Description |
|----------|-------|-------------|
| `MEDIA_PAYLOAD_TYPE_JPG` | 5 | JPEG image format |
| `MEDIA_PAYLOAD_TYPE_PNG` | 6 | PNG image format |
| `MEDIA_PAYLOAD_TYPE_H264` | 7 | H.264 video format |

### Resolution & FPS

Same values as video parameters. For screen share:
- Lower FPS (1-5) recommended for static content
- Higher FPS (15-30) for video playback or animations

## Transcript Parameters

### Content Type

| Constant | Value | Description |
|----------|-------|-------------|
| `MEDIA_CONTENT_TYPE_TEXT` | 5 | Plain text format |

### Language ID

| Constant | Value | Language |
|----------|-------|----------|
| `LANGUAGE_ID_ARABIC` | 0 | Arabic |
| `LANGUAGE_ID_BENGALI` | 1 | Bengali |
| `LANGUAGE_ID_CANTONESE` | 2 | Cantonese |
| `LANGUAGE_ID_CATALAN` | 3 | Catalan |
| `LANGUAGE_ID_CHINESE_SIMPLIFIED` | 4 | Chinese (Simplified) |
| `LANGUAGE_ID_CHINESE_TRADITIONAL` | 5 | Chinese (Traditional) |
| `LANGUAGE_ID_CZECH` | 6 | Czech |
| `LANGUAGE_ID_DANISH` | 7 | Danish |
| `LANGUAGE_ID_DUTCH` | 8 | Dutch |
| `LANGUAGE_ID_ENGLISH` | 9 | English |
| `LANGUAGE_ID_ESTONIAN` | 10 | Estonian |
| `LANGUAGE_ID_FINNISH` | 11 | Finnish |
| `LANGUAGE_ID_FRENCH_CANADA` | 12 | French (Canada) |
| `LANGUAGE_ID_FRENCH_FRANCE` | 13 | French (France) |
| `LANGUAGE_ID_GERMAN` | 14 | German |
| `LANGUAGE_ID_HEBREW` | 15 | Hebrew |
| `LANGUAGE_ID_HINDI` | 16 | Hindi |
| `LANGUAGE_ID_HUNGARIAN` | 17 | Hungarian |
| `LANGUAGE_ID_INDONESIAN` | 18 | Indonesian |
| `LANGUAGE_ID_ITALIAN` | 19 | Italian |
| `LANGUAGE_ID_JAPANESE` | 20 | Japanese |
| `LANGUAGE_ID_KOREAN` | 21 | Korean |
| `LANGUAGE_ID_MALAY` | 22 | Malay |
| `LANGUAGE_ID_PERSIAN` | 23 | Persian |
| `LANGUAGE_ID_POLISH` | 24 | Polish |
| `LANGUAGE_ID_PORTUGUESE` | 25 | Portuguese |
| `LANGUAGE_ID_ROMANIAN` | 26 | Romanian |
| `LANGUAGE_ID_RUSSIAN` | 27 | Russian |
| `LANGUAGE_ID_SPANISH` | 28 | Spanish |
| `LANGUAGE_ID_SWEDISH` | 29 | Swedish |
| `LANGUAGE_ID_TAGALOG` | 30 | Tagalog |
| `LANGUAGE_ID_TAMIL` | 31 | Tamil |
| `LANGUAGE_ID_TELUGU` | 32 | Telugu |
| `LANGUAGE_ID_THAI` | 33 | Thai |
| `LANGUAGE_ID_TURKISH` | 34 | Turkish |
| `LANGUAGE_ID_UKRAINIAN` | 35 | Ukrainian |
| `LANGUAGE_ID_VIETNAMESE` | 36 | Vietnamese |

## Chat Parameters

### Content Type

| Constant | Value | Description |
|----------|-------|-------------|
| `MEDIA_CONTENT_TYPE_TEXT` | 5 | Plain text format |

## Example Configuration

```javascript
const mediaParams = {
  audio: {
    content_type: 2,  // MEDIA_CONTENT_TYPE_RAW_AUDIO
    sample_rate: 1,   // AUDIO_SAMPLE_RATE_SR_16K (16kHz)
    channel: 1,       // AUDIO_CHANNEL_MONO
    codec: 1,         // MEDIA_PAYLOAD_TYPE_L16 (PCM)
    data_opt: 1,      // MEDIA_DATA_OPTION_AUDIO_MIXED_STREAM
    send_rate: 20     // milliseconds between packets (recommended: 20ms)
  },
  video: {
    content_type: 3,  // MEDIA_CONTENT_TYPE_RAW_VIDEO
    codec: 7,         // MEDIA_PAYLOAD_TYPE_H264
    resolution: 2,    // MEDIA_RESOLUTION_HD (720p)
    fps: 25,
    data_opt: 3       // MEDIA_DATA_OPTION_VIDEO_SINGLE_ACTIVE_STREAM
  },
  deskshare: {
    content_type: 3,  // MEDIA_CONTENT_TYPE_RAW_VIDEO
    codec: 5,         // MEDIA_PAYLOAD_TYPE_JPG
    resolution: 2,    // MEDIA_RESOLUTION_HD
    fps: 1
  },
  transcript: {
    content_type: 5,  // MEDIA_CONTENT_TYPE_TEXT
    language: 9       // LANGUAGE_ID_ENGLISH
  },
  chat: {
    content_type: 5   // MEDIA_CONTENT_TYPE_TEXT
  }
};
```

## Using with RTMSManager

```javascript
import { RTMSManager } from './library/javascript/rtmsManager/RTMSManager.js';

const { MEDIA_PARAMS } = RTMSManager;

const config = {
  mediaParams: {
    audio: {
      contentType: MEDIA_PARAMS.MEDIA_CONTENT_TYPE_RAW_AUDIO,
      sampleRate: MEDIA_PARAMS.AUDIO_SAMPLE_RATE_SR_16K,
      channel: MEDIA_PARAMS.AUDIO_CHANNEL_MONO,
      codec: MEDIA_PARAMS.MEDIA_PAYLOAD_TYPE_L16,
      dataOpt: MEDIA_PARAMS.MEDIA_DATA_OPTION_AUDIO_MIXED_STREAM,
      sendRate: 20  // recommended
    },
    video: {
      contentType: MEDIA_PARAMS.MEDIA_CONTENT_TYPE_RAW_VIDEO,
      codec: MEDIA_PARAMS.MEDIA_PAYLOAD_TYPE_H264,
      dataOpt: MEDIA_PARAMS.MEDIA_DATA_OPTION_VIDEO_SINGLE_ACTIVE_STREAM,
      resolution: MEDIA_PARAMS.MEDIA_RESOLUTION_HD,
      fps: 25
    },
    transcript: {
      contentType: MEDIA_PARAMS.MEDIA_CONTENT_TYPE_TEXT,
      language: MEDIA_PARAMS.LANGUAGE_ID_ENGLISH
    }
  }
};
```

## Related Documentation

- [RTMS_CONNECTION_FLOW.md](./RTMS_CONNECTION_FLOW.md) - Complete protocol with code examples
- [library/javascript/README.md](./library/javascript/README.md) - RTMSManager API reference
