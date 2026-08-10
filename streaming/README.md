# Streaming Samples

> **Advanced Topic**: These samples demonstrate real-time media streaming and require optimization to achieve proper performance and audio/video synchronization.

## Overview

This folder contains samples for streaming Zoom meeting media to external destinations in real-time.

## Samples

| Sample | Strategy | Description |
|--------|----------|-------------|
| `stream_audio_and_video_to_youtube_greedy_gap_filler_js` | Greedy Gap Filler | Streams to YouTube Live using binary denomination buffers (320, 160, 80...1ms) to fill exact gaps during mute |
| `stream_audio_and_video_to_custom_frontend_passthru_js` | Passthru | Streams to HLS for browser playback with no buffering strategy |
| `stream_audio_and_video_to_custom_frontend_sdk` | SDK | Uses RTMS SDK for custom frontend streaming |
| `stream_to_aws_ivs_gap_filler_js` | Gap Filler | Streams to AWS IVS with mute detection (>320ms gap) and continuous black frame injection |
| `stream_to_aws_ivs_jitter_buffer_js` | Jitter Buffer | Streams to AWS IVS with packet buffering, sorting by timestamp, and frame selection every 40ms |
| `stream_to_aws_kinesis_passthru_js` | Passthru | Forwards raw media to AWS Kinesis Video Streams |

## Strategy Comparison

| Strategy | Latency | Sync Quality | Use Case |
|----------|---------|--------------|----------|
| **Passthru** | Lowest | Depends on destination | Simple forwarding, destination handles sync |
| **Gap Filler** | Low | Good | Live streaming where immediate write is needed |
| **Jitter Buffer** | Medium | Best | Recording or destinations requiring precise timing |
| **Greedy Gap Filler** | Low | Good | Precise gap filling with minimal overhead |

## Features

All JS samples include:

- **Unified media connection**: Single WebSocket for audio + video (`media_type: 3`)
- **Keep-alive handling**: Responds to `msg_type: 12` with `msg_type: 13` on both signaling and media sockets
- **Reconnection strategy**: Auto-reconnects with 3s delay on connection drop
- **Stream-based keying**: Uses `streamId` (not `meetingUuid`) as the unique connection identifier

## Key Considerations

1. **Network Jitter**: Packets may arrive out of order or with variable delays
2. **Mute Handling**: Video stops during mute; audio may send silence or stop
3. **A/V Sync**: Audio and video have independent timing that must be aligned
4. **FFmpeg Buffering**: Encoder settings affect latency vs quality tradeoff
5. **Reconnection**: Samples auto-reconnect on disconnect; set `shouldReconnect = false` to stop

## Requirements

- FFmpeg installed and available in PATH
- Destination credentials (YouTube stream key, AWS credentials, etc.)
- Black frame H.264 files for gap filling (included in advance samples)
