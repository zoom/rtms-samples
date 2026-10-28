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

> **Deprecated:** Unified media socket mode and `media_type: 32` must not be
> used. Open a separate data connection for each required media type and send
> one concrete media type per handshake.

Generic boilerplates require an explicit comma-separated media selection:

```env
RTMS_MEDIA_TYPES=audio,video,transcript
```

Supported names are `audio`, `video`, `screenshare`, `transcript`, and `chat`.
Each selected name opens a separate data connection. Purpose-built samples
select only the media they require in code.

## Quick Start

```javascript
import { RTMSManager } from './library/javascript/rtmsManager/RTMSManager.js';
import WebhookManager from './library/javascript/webhookManager/WebhookManager.js';
import express from 'express';

const app = express();

// Initialize
await RTMSManager.init({
  mediaTypes: RTMSManager.MEDIA.AUDIO | RTMSManager.MEDIA.TRANSCRIPT,
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

→ **Full examples**: [`boilerplate/`](./boilerplate/) | **Library docs**: [`library/javascript/readme.md`](./library/javascript/readme.md)

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
│   ├── send_audio_to_zoom_scribe_transcribe_service_js/
│   └── send_individual_audio_to_zoom_scribe_transcribe_service_js/
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
├── chat/                           # In-meeting chat processing samples
│   └── print_chat_messages_js/
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
│   ├── save_audio_and_video_to_local_storage_sdk/
│   └── save_edited_audio_and_video_to_local_storage_js/
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
    ├── jev_transcript_analysis_js/
    ├── prompt_for_user_consent_js/
    ├── send_audio_to_openai_realtime_api_with_audio_playback_js/
    ├── start_stop_rtms_control_js/
    └── stream_audio_and_video_deepfake_detection_js/
```

## Sample Categories

| Category | Description | Count |
|----------|-------------|-------|
| [`audio/`](./audio/) | Transcription services (AWS, Azure, OpenAI Realtime, Zoom Scribe, AssemblyAI, Whisper) | 10 |
| [`boilerplate/`](./boilerplate/) | Starter templates (JS, Python, Go, Java, C++, .NET, SDK) | 9 |
| [`chat/`](./chat/) | In-meeting chat message processing | 1 |
| [`streaming/`](./streaming/) | Live streaming (AWS IVS, Kinesis, YouTube, custom) | 6 |
| [`storage/`](./storage/) | Cloud & local storage (S3, Azure Blob, local, edited media) | 7 |
| [`transcript/`](./transcript/) | Transcript processing & LLM integration | 5 |
| [`zoom_apps/`](./zoom_apps/) | Complete Zoom App examples (AI, RAG, games, Jev, deepfake detection) | 10 |
| [`video/`](./video/) | Video analysis and individual video stream samples | 3 |
| [`video-sdk/`](./video-sdk/) | Video SDK integration | 3 |
| [`screen_share/`](./screen_share/) | Screen capture & PDF export | 2 |
| [`rtms_api/`](./rtms_api/) | Manual RTMS session control and reconnection testing | 3 |
| [`rtms-distributed-sample/`](./rtms-distributed-sample/) | Distributed RTMS fanout/fanin sample with regional compute, control stores, cache, and artifact storage | 1 |
| [`rtms_mcp_client/`](./rtms_mcp_client/) | Model Context Protocol client | 1 |
| [`library/`](./library/) | Shared utilities (RTMSManager, helpers) | 2 |

## Project Catalog

Each link opens the project directory and its project-level `readme.md`.

### Audio

| Project | Description |
|---|---|
| [`send_audio_to_assemblyai_transcribe_service_js`](./audio/send_audio_to_assemblyai_transcribe_service_js/) | Sends RTMS audio to AssemblyAI using a direct JavaScript integration. |
| [`send_audio_to_assemblyai_transcribe_service_sdk`](./audio/send_audio_to_assemblyai_transcribe_service_sdk/) | Sends RTMS audio to AssemblyAI using the SDK-oriented sample structure. |
| [`send_audio_to_aws_transcribe_service_js`](./audio/send_audio_to_aws_transcribe_service_js/) | Transcribes RTMS audio with Amazon Transcribe from JavaScript. |
| [`send_audio_to_aws_transcribe_service_sdk`](./audio/send_audio_to_aws_transcribe_service_sdk/) | Transcribes RTMS audio with the AWS SDK integration pattern. |
| [`send_audio_to_azure_speech_to_text_service_js`](./audio/send_audio_to_azure_speech_to_text_service_js/) | Sends RTMS audio to Azure Speech-to-Text. |
| [`send_audio_to_azure_speech_to_text_service_sdk`](./audio/send_audio_to_azure_speech_to_text_service_sdk/) | Sends RTMS audio to Azure Speech using the SDK-oriented pattern. |
| [`send_audio_to_openai_realtime_api`](./audio/send_audio_to_openai_realtime_api/) | Streams RTMS audio to OpenAI Realtime for conversational audio processing. |
| [`send_audio_to_whisper_local_transcribe_service_js`](./audio/send_audio_to_whisper_local_transcribe_service_js/) | Sends RTMS audio to a local Whisper transcription service. |
| [`send_audio_to_zoom_scribe_transcribe_service_js`](./audio/send_audio_to_zoom_scribe_transcribe_service_js/) | Buffers RTMS audio windows and sends them to Zoom Scribe Fast transcription. |
| [`send_individual_audio_to_zoom_scribe_transcribe_service_js`](./audio/send_individual_audio_to_zoom_scribe_transcribe_service_js/) | Sends individual participant audio windows to Zoom Scribe for transcription. |

### Boilerplate

| Project | Description |
|---|---|
| [`working_cplusplus_wss`](./boilerplate/working_cplusplus_wss/) | C++ WebSocket RTMS starter with direct signaling and media connections. |
| [`working_dotnetcore`](./boilerplate/working_dotnetcore/) | .NET starter for receiving RTMS events and media. |
| [`working_go`](./boilerplate/working_go/) | Go RTMS starter implementation. |
| [`working_java`](./boilerplate/working_java/) | Java RTMS starter implementation. |
| [`working_js`](./boilerplate/working_js/) | JavaScript starter using the shared RTMSManager. |
| [`working_python`](./boilerplate/working_python/) | Python starter for direct RTMS WebSocket handling. |
| [`working_python_wss`](./boilerplate/working_python_wss/) | Python WebSocket starter with the RTMS handshake flow. |
| [`working_python_wss_zoom_room_screenshot`](./boilerplate/working_python_wss_zoom_room_screenshot/) | Python RTMS starter that captures Zoom Room screenshots. |
| [`working_sdk`](./boilerplate/working_sdk/) | JavaScript starter using the RTMS SDK wrapper and authenticated webhooks. |

### Chat, RTMS Control, And Screen Share

| Project | Description |
|---|---|
| [`print_chat_messages_js`](./chat/print_chat_messages_js/) | Receives and prints in-meeting RTMS chat messages. |
| [`manual_start_stop_using_js`](./rtms_api/manual_start_stop_using_js/) | Starts and stops RTMS sessions from JavaScript. |
| [`manual_start_stop_using_python`](./rtms_api/manual_start_stop_using_python/) | Starts and stops RTMS sessions from Python. |
| [`reconnection_and_chaos_mode_js`](./rtms_api/reconnection_and_chaos_mode_js/) | Exercises RTMS reconnection and failure-handling behavior. |
| [`save_screen_share_js`](./screen_share/save_screen_share_js/) | Saves RTMS screen-share frames to local files. |
| [`save_screen_share_pdf_js`](./screen_share/save_screen_share_pdf_js/) | Converts captured RTMS screen-share frames into PDF output. |

### Storage

| Project | Description |
|---|---|
| [`save_audio_and_video_to_aws_s3_storage_js`](./storage/save_audio_and_video_to_aws_s3_storage_js/) | Records RTMS audio/video and uploads artifacts to Amazon S3. |
| [`save_audio_and_video_to_aws_s3_storage_sdk`](./storage/save_audio_and_video_to_aws_s3_storage_sdk/) | Archives RTMS audio/video to S3 using the SDK-oriented pattern. |
| [`save_audio_and_video_to_azure_blob_storage_js`](./storage/save_audio_and_video_to_azure_blob_storage_js/) | Saves RTMS audio/video artifacts to Azure Blob Storage. |
| [`save_audio_and_video_to_azure_blob_storage_sdk`](./storage/save_audio_and_video_to_azure_blob_storage_sdk/) | Saves RTMS audio/video to Azure Blob with the SDK pattern. |
| [`save_audio_and_video_to_local_storage_js`](./storage/save_audio_and_video_to_local_storage_js/) | Saves RTMS audio and video media to local storage. |
| [`save_audio_and_video_to_local_storage_sdk`](./storage/save_audio_and_video_to_local_storage_sdk/) | Saves RTMS media locally using the SDK-oriented pattern. |
| [`save_edited_audio_and_video_to_local_storage_js`](./storage/save_edited_audio_and_video_to_local_storage_js/) | Creates AI-assisted edited media from RTMS recordings and stores it locally. |

### Streaming

| Project | Description |
|---|---|
| [`stream_audio_and_video_to_custom_frontend_passthru_js`](./streaming/stream_audio_and_video_to_custom_frontend_passthru_js/) | Passes RTMS audio/video through a backend to a custom frontend player. |
| [`stream_audio_and_video_to_custom_frontend_sdk`](./streaming/stream_audio_and_video_to_custom_frontend_sdk/) | Streams RTMS media to a custom frontend using the SDK pattern. |
| [`stream_audio_and_video_to_youtube_greedy_gap_filler_js`](./streaming/stream_audio_and_video_to_youtube_greedy_gap_filler_js/) | Streams RTMS media to YouTube with keyframe-based gap filling. |
| [`stream_to_aws_ivs_gap_filler_js`](./streaming/stream_to_aws_ivs_gap_filler_js/) | Publishes RTMS media to AWS IVS with gap-filler frames. |
| [`stream_to_aws_ivs_jitter_buffer_js`](./streaming/stream_to_aws_ivs_jitter_buffer_js/) | Publishes RTMS media to AWS IVS through a jitter buffer. |
| [`stream_to_aws_kinesis_passthru_js`](./streaming/stream_to_aws_kinesis_passthru_js/) | Passes RTMS audio/video into AWS Kinesis using passthrough media. |

### Transcripts

| Project | Description |
|---|---|
| [`save_transcript_js`](./transcript/save_transcript_js/) | Saves RTMS transcripts and exports text, VTT, and SRT formats. |
| [`save_transcript_sdk`](./transcript/save_transcript_sdk/) | Saves transcripts using the SDK-oriented webhook and storage pattern. |
| [`send_transcript_to_claude_js`](./transcript/send_transcript_to_claude_js/) | Sends meeting transcript turns to Anthropic Claude for analysis. |
| [`send_transcript_to_openai_js`](./transcript/send_transcript_to_openai_js/) | Sends meeting transcript turns to OpenAI for analysis. |
| [`send_transcript_to_openrouter_js`](./transcript/send_transcript_to_openrouter_js/) | Sends meeting transcript turns to a configurable OpenRouter model. |

### Video And Video SDK

| Project | Description |
|---|---|
| [`detect_emotion_using_amazon_rekognition_js`](./video/detect_emotion_using_amazon_rekognition_js/) | Analyzes RTMS video frames with Amazon Rekognition emotion detection. |
| [`detect_object_using_tensorflow_js`](./video/detect_object_using_tensorflow_js/) | Decodes RTMS H.264 video and runs TensorFlow object detection. |
| [`individual_video_js`](./video/individual_video_js/) | Subscribes to and processes an individual participant video stream. |
| [`vsdk_working_java`](./video-sdk/vsdk_working_java/) | Java Video SDK sample with media and meeting event handling. |
| [`vsdk_working_js`](./video-sdk/vsdk_working_js/) | JavaScript Video SDK sample with media and meeting event handling. |
| [`vsdk_working_python`](./video-sdk/vsdk_working_python/) | Python Video SDK sample with media and meeting event handling. |

### Zoom Apps

| Project | Description |
|---|---|
| [`ai_chat_with_audio_playback_js`](./zoom_apps/ai_chat_with_audio_playback_js/) | Zoom App combining meeting audio, AI chat, and audio playback. |
| [`ai_dnd_game_js`](./zoom_apps/ai_dnd_game_js/) | Zoom App that turns meeting interaction into an AI-assisted game. |
| [`ai_industry_specific_notetaker_js`](./zoom_apps/ai_industry_specific_notetaker_js/) | Zoom App that analyzes meeting transcripts for industry-specific notes. |
| [`ai_rag_customer_support_js`](./zoom_apps/ai_rag_customer_support_js/) | Zoom App combining transcript context with retrieval-augmented support answers. |
| [`ai_transcript_analysis_js`](./zoom_apps/ai_transcript_analysis_js/) | Zoom App that sends RTMS transcript turns to an external AI analysis service. |
| [`jev_transcript_analysis_js`](./zoom_apps/jev_transcript_analysis_js/) | Zoom App showing turn-by-turn sales coaching using TypeSafe AI Jev decisions. |
| [`zoom_decisions_compliance_risk_copilot_js`](./zoom_apps/zoom_decisions_compliance_risk_copilot_js/) | Zoom App using Zoom Decisions to score compliance risk and recommend agent actions. |
| [`prompt_for_user_consent_js`](./zoom_apps/prompt_for_user_consent_js/) | Zoom App that tracks participant consent before processing meeting data. |
| [`send_audio_to_openai_realtime_api_with_audio_playback_js`](./zoom_apps/send_audio_to_openai_realtime_api_with_audio_playback_js/) | Zoom App sending meeting audio to OpenAI Realtime and playing responses back. |
| [`start_stop_rtms_control_js`](./zoom_apps/start_stop_rtms_control_js/) | Zoom App that starts and stops RTMS from the Zoom Apps SDK. |
| [`stream_audio_and_video_deepfake_detection_js`](./zoom_apps/stream_audio_and_video_deepfake_detection_js/) | Zoom App previewing individual media and sending clips to deepfake detection services. |

### Distributed, MCP, And Shared Components

| Project | Description |
|---|---|
| [`rtms-distributed-sample`](./rtms-distributed-sample/) | Distributed RTMS webhook routing, regional compute, queues, caches, and artifact storage. |
| [`zoom-rtms-mcp-client`](./rtms_mcp_client/zoom-rtms-mcp-client/) | Routes RTMS transcript turns through an MCP client and configurable LLM router. |
| [`library/javascript`](./library/javascript/) | Shared JavaScript RTMSManager, webhook, media, and frontend WebSocket helpers. |
| [`library/python`](./library/python/) | Shared Python RTMS utilities and protocol helpers. |

### About the Library & SDK

RTMS streams are delivered over standard WebSocket connections—**no SDK or library is required**. The [`library/`](./library/) and SDK are provided purely for convenience:

- **Helper classes** for audio/video processing
- **Reconnection managers** for handling network interruptions
- **Event routing** and connection lifecycle management

For advanced use cases requiring performance optimization or unique customization, you can modify the library code or implement your own WebSocket handling directly. See [RTMS_CONNECTION_FLOW.md](./RTMS_CONNECTION_FLOW.md) for the complete protocol specification.

## Documentation

| Document | Description |
|----------|-------------|
| [CHANGELOG.md](./CHANGELOG.md) | User-facing changes and migration notes |
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
