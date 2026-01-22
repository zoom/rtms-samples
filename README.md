# Zoom RTMS Samples Repository

This repository contains sample projects demonstrating how to work with Zoom's Realtime Media Streams (RTMS) in JavaScript, Python, and SDK implementations.

## What is RTMS?

Zoom Realtime Media Streams (RTMS) allows developers to access realtime media data from Zoom meetings, including:
- **Audio streams** - Raw PCM audio (L16, 16kHz/24kHz)
- **Video streams** - H.264 encoded video
- **Transcripts** - Real-time speech-to-text
- **Screen shares** - JPEG/PNG/H.264 frames
- **Chat messages** - In-meeting chat

## Quick Start

```javascript
import { RTMSManager } from './library/javascript/rtmsManager/RTMSManager.js';
import WebhookManager from './library/javascript/webhookManager/WebhookManager.js';
import express from 'express';

const app = express();

// 1. Configure RTMS
await RTMSManager.init({
  credentials: {
    meeting: {
      clientId: process.env.ZOOM_CLIENT_ID,
      clientSecret: process.env.ZOOM_CLIENT_SECRET,
      zoomSecretToken: process.env.ZOOM_SECRET_TOKEN,
    }
  },
  mediaParams: {
    audio: { codec: 'L16', sampleRate: 16000 },
    transcript: { language: 'en' }
  }
});

// 2. Setup webhook to receive Zoom events
const webhookManager = new WebhookManager({
  config: { webhookPath: '/', zoomSecretToken: process.env.ZOOM_SECRET_TOKEN },
  app
});
webhookManager.on('event', (event, payload) => RTMSManager.handleEvent(event, payload));
webhookManager.setup();

// 3. Handle real-time media
RTMSManager.on('audio', ({ buffer, userId, userName, timestamp }) => {
  console.log(`Audio from ${userName}: ${buffer.length} bytes`);
});

RTMSManager.on('transcript', ({ text, userName }) => {
  console.log(`${userName}: ${text}`);
});

// 4. Start
await RTMSManager.start();
app.listen(3000);
```

## Featured Use Cases

### Real-time Note-Taking with NLP
[`zoom_apps/ai_industry_specific_notetaker_js/`](./zoom_apps/ai_industry_specific_notetaker_js/)

Build a meeting assistant that extracts entities, detects action items, classifies topics, and generates summaries in real-time.

```
Zoom Meeting → RTMS Webhook → WebSocket → Transcript → NLP Pipeline → Frontend
```

```javascript
RTMSManager.on('transcript', async ({ text, userName }) => {
  // Named Entity Recognition
  const entities = await detectEntities(text);
  
  // Action item detection (regex-based)
  const actions = detectActionItems(text);
  
  // Topic classification via LLM
  const topic = await classifyTopic(text);
  
  // Periodic summarization
  if (transcriptHistory.length % 5 === 0) {
    summary = await summarize(transcriptHistory.join(' '));
  }
  
  // Broadcast to connected frontends
  frontendWss.broadcast({ text, entities, actions, topic, summary, user: userName });
});
```

**Features:**
- Real-time entity extraction (people, organizations, dates)
- Action item detection ("we need to", "let's", "follow up")
- Topic classification (Finance, Legal, Tech, HR)
- Rolling meeting summaries
- WebSocket broadcast to frontend dashboard

### AI-Powered Applications
| Sample | Description |
|--------|-------------|
| [`ai_industry_specific_notetaker_js`](./zoom_apps/ai_industry_specific_notetaker_js/) | NLP pipeline: NER, action items, topics, summaries |
| [`ai_transcript_analysis_js`](./zoom_apps/ai_transcript_analysis_js/) | Real-time transcript analysis |
| [`ai_rag_customer_support_js`](./zoom_apps/ai_rag_customer_support_js/) | Customer service AI with RAG |
| [`ai_chat_with_audio_playback_js`](./zoom_apps/ai_chat_with_audio_playback_js/) | LLM chatbot with neural audio playback |
| [`ai_dnd_game_js`](./zoom_apps/ai_dnd_game_js/) | D&D game powered by transcripts |

### Multi-Provider Transcription
| Sample | Description |
|--------|-------------|
| [`send_audio_to_deepgram_transcribe_service_js`](./audio/send_audio_to_deepgram_transcribe_service_js/) | Deepgram real-time transcription |
| [`send_audio_to_assemblyai_transcribe_service_js`](./audio/send_audio_to_assemblyai_transcribe_service_js/) | AssemblyAI transcription |
| [`send_audio_to_aws_transcribe_service_js`](./audio/send_audio_to_aws_transcribe_service_js/) | AWS Transcribe integration |
| [`send_audio_to_azure_speech_to_text_service_js`](./audio/send_audio_to_azure_speech_to_text_service_js/) | Azure Speech-to-Text |

### Cloud Storage
| Sample | Description |
|--------|-------------|
| [`save_audio_and_video_to_aws_s3_storage_js`](./storage/save_audio_and_video_to_aws_s3_storage_js/) | Save recordings to AWS S3 |
| [`save_audio_and_video_to_azure_blob_storage_js`](./storage/save_audio_and_video_to_azure_blob_storage_js/) | Save recordings to Azure Blob |
| [`save_audio_and_video_to_local_storage_js`](./storage/save_audio_and_video_to_local_storage_js/) | Save recordings locally |

### Live Streaming
| Sample | Strategy | Description |
|--------|----------|-------------|
| [`stream_to_aws_ivs_gap_filler_js`](./streaming/stream_to_aws_ivs_gap_filler_js/) | Gap Filler | Stream to AWS IVS with mute detection |
| [`stream_to_aws_ivs_jitter_buffer_js`](./streaming/stream_to_aws_ivs_jitter_buffer_js/) | Jitter Buffer | Stream to AWS IVS with packet reordering |
| [`stream_audio_and_video_to_youtube_greedy_gap_filler_js`](./streaming/stream_audio_and_video_to_youtube_greedy_gap_filler_js/) | Greedy Gap Filler | Stream to YouTube Live |
| [`stream_audio_and_video_to_custom_frontend_passthru_js`](./streaming/stream_audio_and_video_to_custom_frontend_passthru_js/) | Passthru | Stream to custom HLS frontend |

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
│   ├── send_audio_to_deepgram_transcribe_service_js/
│   └── send_audio_to_deepgram_transcribe_service_sdk/
├── boilerplate/                    # Starter templates for various languages
│   ├── working_cplusplus_wss/
│   ├── working_dotnetcore/
│   ├── working_go/
│   ├── working_js/
│   ├── working_python/
│   ├── working_python_wss/
│   └── working_sdk/
├── library/                        # Shared JavaScript library (RTMSManager)
│   └── javascript/
│       ├── rtmsManager/            # Core RTMS connection management
│       ├── webhookManager/         # Zoom webhook handling
│       ├── webSocketManager/       # Zoom WebSocket event handling
│       └── commonHelpers/          # Audio/video processing utilities
├── rtms_api/                       # Manual RTMS start/stop control
│   ├── manual_start_stop_using_js/
│   └── manual_start_stop_using_python/
├── rtms_mcp_client/                # Model Context Protocol integration
│   └── zoom-rtms-mcp-client/
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
│   └── detect_object_using_tensorflow_js/
└── zoom_apps/                      # Complete Zoom App examples
    ├── ai_chat_with_audio_playback_js/
    ├── ai_dnd_game_js/
    ├── ai_industry_specific_notetaker_js/
    ├── ai_rag_customer_support_js/
    ├── ai_transcript_analysis_js/
    ├── prompt_for_user_consent_js/
    └── start_stop_rtms_control_js/
```

## Architecture

### RTMS Connection Flow

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   Zoom Meeting  │────▶│  Webhook Event   │────▶│   Your Server   │
│                 │     │ meeting.rtms_    │     │                 │
│                 │     │ started          │     │                 │
└─────────────────┘     └──────────────────┘     └────────┬────────┘
                                                          │
                        ┌──────────────────┐              │
                        │ Signaling WSS    │◀─────────────┘
                        │ (Handshake)      │
                        └────────┬─────────┘
                                 │
                        ┌────────▼─────────┐
                        │  Media WSS       │
                        │ (Audio/Video/    │
                        │  Transcript)     │
                        └────────┬─────────┘
                                 │
                        ┌────────▼─────────┐
                        │  Your Processing │
                        │  (NLP, Storage,  │
                        │   Streaming)     │
                        └──────────────────┘
```

### Implementation Approaches

#### 1. RTMSManager (Recommended)
The `RTMSManager` library handles connection management, reconnection, and event routing automatically:

```javascript
import { RTMSManager } from './library/javascript/rtmsManager/RTMSManager.js';

await RTMSManager.init(config);
RTMSManager.on('audio', handleAudio);
RTMSManager.on('video', handleVideo);
RTMSManager.on('transcript', handleTranscript);
await RTMSManager.start();
```

#### 2. SDK-Based
The RTMS SDK provides a simplified interface with built-in error handling:
- Automatic connection management
- Built-in reconnection logic
- Cross-platform compatibility

#### 3. Native WebSocket
For maximum control, implement WebSocket connections directly:
- Manual handshake and authentication
- Custom reconnection strategies
- Direct binary data processing

## Creating an App in the Zoom Marketplace

1. **Sign in**: Go to https://marketplace.zoom.us/ with your RTMS-enabled account

2. **Create App**: Develop → Build App → General App → User-Managed

3. **Configure Event Subscriptions**:
   - Features → Access → Enable Event Subscription
   - Add Events → Search "rtms" → Select RTMS endpoints

4. **Configure Scopes**:
   - Scopes → Add Scopes → Search "rtms"
   - Add scopes for both "Meetings" and "Rtms"

5. **Get Credentials**:
   - Client ID
   - Client Secret
   - Webhook verification token (Secret Token)

## Media Parameters

### Audio
| Parameter | Options |
|-----------|---------|
| Sample Rate | 8kHz, 16kHz, 24kHz, 32kHz, 48kHz |
| Codec | L16 (PCM), OPUS |
| Channels | Mono, Stereo |
| Data Option | Mixed stream, Individual streams |

### Video
| Parameter | Options |
|-----------|---------|
| Codec | H.264, VP8 |
| Resolution | SD (640x360), HD (1280x720), FHD (1920x1080) |
| FPS | 1-30 |
| Data Option | Single active speaker, All participants |

### Transcript
| Parameter | Options |
|-----------|---------|
| Language | English, Spanish, French, German, etc. |
| Content Type | Text |

## Troubleshooting

### Connection Issues
- Verify ngrok/tunnel is running and accessible
- Check Zoom OAuth credentials in `.env`
- Ensure webhook URL is correctly configured in Zoom Marketplace

### No Audio/Video Data
- Verify RTMS is enabled for your app (Zoom web settings)
- Check that your app has correct RTMS scopes
- Ensure you're handling the `meeting.rtms_started` webhook event

### FFmpeg Conversion Issues
- RTMS audio: L16 PCM at 16kHz/24kHz, mono
- FFmpeg params: `-f s16le -ar 16000 -ac 1`
- Ensure FFmpeg is installed and in PATH

### SDK Installation
```bash
npm install github:zoom/rtms
```
Ensure you have the correct token for fetching prebuilt binaries.

## License

MIT License - Copyright (c) 2025 Zoom Video Communications, Inc.

See [LICENSE](./LICENSE) for full text.
