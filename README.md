# Zoom RTMS Samples Repository

This repository contains sample projects demonstrating how to work with Zoom's Realtime Media Streams (RTMS) in JavaScript, Python, Go, Java, C++, .NET, and SDK implementations.

## What is RTMS?

Zoom Realtime Media Streams (RTMS) allows developers to access realtime media data from Zoom meetings, including:
- **Audio streams** - Raw PCM audio (L16, 16kHz/24kHz)
- **Video streams** - H.264 encoded video
- **Transcripts** - Real-time speech-to-text
- **Screen shares** - JPEG/PNG/H.264 frames
- **Chat messages** - In-meeting chat

> **Note**: RTMS is built on standard WebSocket technology. You do **not** need the SDK or library to access RTMS streams—you can connect directly using any WebSocket client in any language. The [`library/`](./library/) and SDK are provided for convenience, offering helper classes, reconnection managers, and event handling. Feel free to use them as-is, modify them, or implement your own logic for advanced use cases. See [RTMS_CONNECTION_FLOW.md](./RTMS_CONNECTION_FLOW.md) for the raw protocol details.

## Quick Start

```javascript
import { RTMSManager } from './library/javascript/rtmsManager/RTMSManager.js';
import WebhookManager from './library/javascript/webhookManager/WebhookManager.js';
import express from 'express';

const app = express();

// Initialize
await RTMSManager.init({
  credentials: {
    meeting: {
      clientId: process.env.ZOOM_CLIENT_ID,
      clientSecret: process.env.ZOOM_CLIENT_SECRET,
      zoomSecretToken: process.env.ZOOM_SECRET_TOKEN,
    }
  }
});

// Setup webhook
const webhookManager = new WebhookManager({
  config: { webhookPath: '/', zoomSecretToken: process.env.ZOOM_SECRET_TOKEN },
  app
});
webhookManager.on('event', (event, payload) => RTMSManager.handleEvent(event, payload));
webhookManager.setup();

// Handle media
RTMSManager.on('audio', ({ buffer, userName }) => console.log(`Audio from ${userName}`));
RTMSManager.on('transcript', ({ text, userName }) => console.log(`${userName}: ${text}`));

// Start
await RTMSManager.start();
app.listen(3000);
```

→ **Full examples**: [`boilerplate/`](./boilerplate/) | **Library docs**: [`library/javascript/README.md`](./library/javascript/README.md)

## Repository Structure

```
.
├── audio/                          # Audio processing & transcription samples
│   ├── send_audio_to_assemblyai_transcribe_service_js/
│   ├── send_audio_to_assemblyai_transcribe_service_sdk/
│   ├── send_audio_to_aws_transcribe_service_js/
│   ├── send_audio_to_aws_transcribe_service_sdk/
│   ├── send_audio_to_azure_speech_to_text_service_js/
│   ├── send_audio_to_azure_speech_to_text_service_sdk/
│   ├── send_audio_to_openai_realtime_api/
│   ├── send_audio_to_whisper_local_transcribe_service_js/
│   └── send_audio_to_zoom_scribe_transcribe_service_js/
├── boilerplate/                    # Starter templates for various languages
│   ├── working_cplusplus_wss/
│   ├── working_dotnetcore/
│   ├── working_go/
│   ├── working_java/
│   ├── working_js/
│   ├── working_python/
│   ├── working_python_wss/
│   ├── working_python_wss_zoom_room_screenshot/
│   └── working_sdk/
├── library/                        # Shared libraries
│   ├── javascript/                 # RTMSManager, WebhookManager, helpers
│   └── python/                     # Python RTMS utilities
├── rtms_api/                       # Manual RTMS start/stop control
│   ├── manual_start_stop_using_js/
│   ├── manual_start_stop_using_python/
│   └── reconnection_and_chaos_mode_js/
├── rtms-distributed-sample/         # Regional fanout/fanin architecture sample
├── rtms_mcp_client/                # Model Context Protocol integration
├── screen_share/                   # Screen share capture samples
│   ├── save_screen_share_js/
│   └── save_screen_share_pdf_js/
├── storage/                        # Recording & cloud storage samples
│   ├── save_audio_and_video_to_aws_s3_storage_js/
│   ├── save_audio_and_video_to_aws_s3_storage_sdk/
│   ├── save_audio_and_video_to_azure_blob_storage_js/
│   ├── save_audio_and_video_to_azure_blob_storage_sdk/
│   ├── save_audio_and_video_to_local_storage_js/
│   └── save_audio_and_video_to_local_storage_sdk/
├── streaming/                      # Live streaming samples
│   ├── stream_audio_and_video_to_custom_frontend_passthru_js/
│   ├── stream_audio_and_video_to_custom_frontend_sdk/
│   ├── stream_audio_and_video_to_youtube_greedy_gap_filler_js/
│   ├── stream_to_aws_ivs_gap_filler_js/
│   ├── stream_to_aws_ivs_jitter_buffer_js/
│   └── stream_to_aws_kinesis_passthru_js/
├── transcript/                     # Transcript processing samples
│   ├── save_transcript_js/
│   ├── save_transcript_sdk/
│   ├── send_transcript_to_claude_js/
│   ├── send_transcript_to_openai_js/
│   └── send_transcript_to_openrouter_js/
├── video/                          # Video analysis samples
│   ├── detect_emotion_using_amazon_rekognition_js/
│   ├── detect_object_using_tensorflow_js/
│   └── individual_video_js/
├── video-sdk/                      # Video SDK integration samples
│   ├── vsdk_working_java/
│   ├── vsdk_working_js/
│   └── vsdk_working_python/
└── zoom_apps/                      # Complete Zoom App examples
    ├── ai_chat_with_audio_playback_js/
    ├── ai_dnd_game_js/
    ├── ai_industry_specific_notetaker_js/
    ├── ai_rag_customer_support_js/
    ├── ai_transcript_analysis_js/
    ├── prompt_for_user_consent_js/
    ├── start_stop_rtms_control_js/
    └── stream_audio_and_video_deepfake_detection_js/
```

## Sample Categories

| Category | Description | Count |
|----------|-------------|-------|
| [`audio/`](./audio/) | Transcription services (AWS, Azure, OpenAI Realtime, Zoom Scribe, AssemblyAI, Whisper) | 9 |
| [`boilerplate/`](./boilerplate/) | Starter templates (JS, Python, Go, Java, C++, .NET, SDK) | 9 |
| [`streaming/`](./streaming/) | Live streaming (AWS IVS, Kinesis, YouTube, custom) | 6 |
| [`storage/`](./storage/) | Cloud & local storage (S3, Azure Blob, local) | 6 |
| [`transcript/`](./transcript/) | Transcript processing & LLM integration | 5 |
| [`zoom_apps/`](./zoom_apps/) | Complete Zoom App examples (AI, RAG, games, deepfake detection) | 8 |
| [`video/`](./video/) | Video analysis and individual video stream samples | 3 |
| [`video-sdk/`](./video-sdk/) | Video SDK integration | 3 |
| [`screen_share/`](./screen_share/) | Screen capture & PDF export | 2 |
| [`rtms_api/`](./rtms_api/) | Manual RTMS session control and reconnection testing | 3 |
| [`rtms-distributed-sample/`](./rtms-distributed-sample/) | Distributed RTMS fanout/fanin sample with regional compute, control stores, cache, and artifact storage | 1 |
| [`rtms_mcp_client/`](./rtms_mcp_client/) | Model Context Protocol client | 1 |
| [`library/`](./library/) | Shared utilities (RTMSManager, helpers) | 2 |

### About the Library & SDK

RTMS streams are delivered over standard WebSocket connections—**no SDK or library is required**. The [`library/`](./library/) and SDK are provided purely for convenience:

- **Helper classes** for audio/video processing
- **Reconnection managers** for handling network interruptions
- **Event routing** and connection lifecycle management

For advanced use cases requiring performance optimization or unique customization, you can modify the library code or implement your own WebSocket handling directly. See [RTMS_CONNECTION_FLOW.md](./RTMS_CONNECTION_FLOW.md) for the complete protocol specification.

## Documentation

| Document | Description |
|----------|-------------|
| [USE_CASES.md](./USE_CASES.md) | Featured samples & code examples |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Connection flow & implementation approaches |
| [RTMS_CONNECTION_FLOW.md](./RTMS_CONNECTION_FLOW.md) | Raw WebSocket protocol & message types |
| [PRODUCTION.md](./PRODUCTION.md) | Scaling, error handling, monitoring patterns |
| [ZOOM_APP_SETUP.md](./ZOOM_APP_SETUP.md) | Zoom Marketplace app creation guide |
| [MEDIA_PARAMETERS.md](./MEDIA_PARAMETERS.md) | Audio/video/transcript configuration specs |
| [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) | Common issues & fixes |
| [CONTRIBUTING.md](./CONTRIBUTING.md) | Contribution guidelines |

## License

MIT License - Copyright (c) 2025 Zoom Video Communications, Inc.

See [LICENSE.md](./LICENSE.md) for full text.
