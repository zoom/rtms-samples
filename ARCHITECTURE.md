# RTMS Architecture

## Connection Flow (Overview)

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

## Sequence Diagrams

### Full Connection Flow

```mermaid
sequenceDiagram
    participant ZM as Zoom Meeting
    participant ZW as Zoom Webhook
    participant YS as Your Server
    participant SS as Signaling WebSocket
    participant MS as Media WebSocket

    ZM->>ZW: RTMS stream starts
    ZW->>YS: meeting.rtms_started webhook
    Note over YS: Extract meeting_uuid, stream_id, server_urls

    YS->>SS: Connect to signaling URL
    YS->>SS: Send handshake (msg_type: 1)
    Note over SS: Validate signature
    SS-->>YS: Handshake response (msg_type: 2)
    Note over YS: Extract media server URL

    YS->>MS: Connect to media URL
    YS->>MS: Send handshake (msg_type: 3)
    Note over MS: Validate signature
    MS-->>YS: Handshake response (msg_type: 4)

    YS->>SS: Start streaming (msg_type: 7)

    loop Media Streaming
        MS-->>YS: Audio data (msg_type: 14)
        MS-->>YS: Video data (msg_type: 15)
        MS-->>YS: Transcript (msg_type: 17)
    end

    loop Keep-Alive (both sockets)
        SS-->>YS: Keep-alive ping (msg_type: 12)
        YS->>SS: Keep-alive pong (msg_type: 13)
        MS-->>YS: Keep-alive ping (msg_type: 12)
        YS->>MS: Keep-alive pong (msg_type: 13)
    end

    ZM->>ZW: RTMS stream stops
    ZW->>YS: meeting.rtms_stopped webhook
    YS->>MS: Close connection
    YS->>SS: Close connection
```

### Webhook to WebSocket Handshake

```mermaid
sequenceDiagram
    participant Zoom as Zoom Webhook
    participant Server as Your Server
    participant Sig as Signaling WSS

    Zoom->>Server: POST /webhook
    Note over Zoom,Server: meeting.rtms_started<br/>{ meeting_uuid, rtms_stream_id, server_urls }

    Server->>Server: Generate HMAC-SHA256 signature
    Note over Server: message = client_id,meeting_uuid,stream_id<br/>key = client_secret

    Server->>Sig: WebSocket connect(server_urls)
    Server->>Sig: JSON { msg_type: 1, signature, buffer_data: false, ... }
    
    alt Signature Valid
        Sig-->>Server: { msg_type: 2, status_code: 0, media_server: {...} }
        Note over Server: Success! Extract media_server.server_urls.all
    else Signature Invalid
        Sig-->>Server: { msg_type: 2, status_code: 4xx }
        Note over Server: Auth failed - check credentials
    end
```

### Media Handshake and Streaming

```mermaid
sequenceDiagram
    participant Server as Your Server
    participant Sig as Signaling WSS
    participant Media as Media WSS

    Note over Server: Already connected to Signaling

    Server->>Media: WebSocket connect(media_url)
    Server->>Media: JSON { msg_type: 3, media_type: 32, media_params: {...} }
    
    alt Handshake Success
        Media-->>Server: { msg_type: 4, status_code: 0 }
        Server->>Sig: { msg_type: 7, rtms_stream_id }
        Note over Media: Streaming starts
        
        loop Continuous Stream
            Media-->>Server: Audio (msg_type: 14, content: base64)
            Media-->>Server: Video (msg_type: 15, content: base64)
            Media-->>Server: Transcript (msg_type: 17, content: text)
        end
    else Handshake Failed
        Media-->>Server: { msg_type: 4, status_code: 4xx }
        Note over Server: Check media_params configuration
    end
```

### Keep-Alive Protocol

```mermaid
sequenceDiagram
    participant Server as Your Server
    participant WS as WebSocket (Signaling or Media)

    Note over WS: Server sends keep-alive periodically

    WS->>Server: { msg_type: 12, timestamp: 1234567890 }
    
    alt Response in Time
        Server->>WS: { msg_type: 13, timestamp: 1234567890 }
        Note over WS: Connection stays alive
    else No Response / Timeout
        WS->>WS: Close connection
        Note over Server: Must reconnect
    end
```

### Reconnection Flow (RTMSManager Handles This)

```mermaid
sequenceDiagram
    participant Server as Your Server
    participant Sig as Signaling WSS
    participant Media as Media WSS

    Note over Server,Media: Connection lost (network issue, timeout, etc.)

    Media--xServer: Connection closed unexpectedly
    
    Server->>Server: Detect disconnection
    Server->>Server: Wait (exponential backoff)
    
    Note over Server: Attempt 1: wait 1s<br/>Attempt 2: wait 2s<br/>Attempt 3: wait 4s<br/>...

    Server->>Media: Reconnect to media URL
    Server->>Media: Re-send handshake (msg_type: 3)
    Media-->>Server: { msg_type: 4, status_code: 0 }
    Server->>Sig: { msg_type: 7, rtms_stream_id }
    
    Note over Server: Streaming resumes
```

## Implementation Approaches

### 1. RTMSManager (Recommended)

The `RTMSManager` library handles connection management, reconnection, and event routing automatically:

```javascript
import { RTMSManager } from './library/javascript/rtmsManager/RTMSManager.js';

await RTMSManager.init(config);
RTMSManager.on('audio', handleAudio);
RTMSManager.on('video', handleVideo);
RTMSManager.on('transcript', handleTranscript);
await RTMSManager.start();
```

→ See [`library/javascript/README.md`](./library/javascript/README.md) for full API documentation.

### 2. SDK-Based

The RTMS SDK provides a simplified interface with built-in error handling:
- Automatic connection management
- Built-in reconnection logic
- Cross-platform compatibility

→ See [`boilerplate/working_sdk/`](./boilerplate/working_sdk/) for examples.

### 3. Native WebSocket

For maximum control, implement WebSocket connections directly:
- Manual handshake and authentication
- Custom reconnection strategies
- Direct binary data processing

→ See [RTMS_CONNECTION_FLOW.md](./RTMS_CONNECTION_FLOW.md) for the complete protocol specification with code examples in JavaScript, Python, and Go.

## Message Type Summary

| msg_type | Name | Socket | Direction |
|----------|------|--------|-----------|
| 1 | SIGNALING_HANDSHAKE_REQ | Signaling | Client → Server |
| 2 | SIGNALING_HANDSHAKE_RESP | Signaling | Server → Client |
| 3 | MEDIA_HANDSHAKE_REQ | Media | Client → Server |
| 4 | MEDIA_HANDSHAKE_RESP | Media | Server → Client |
| 7 | START_MEDIA_REQ | Signaling | Client → Server |
| 12 | KEEP_ALIVE_REQ | Both | Server → Client |
| 13 | KEEP_ALIVE_RESP | Both | Client → Server |
| 14 | MEDIA_DATA_AUDIO | Media | Server → Client |
| 15 | MEDIA_DATA_VIDEO | Media | Server → Client |
| 16 | MEDIA_DATA_SHARE_SCREEN | Media | Server → Client |
| 17 | MEDIA_DATA_TRANSCRIPT | Media | Server → Client |
| 18 | MEDIA_DATA_CHAT | Media | Server → Client |

## Related Documentation

- [RTMS_CONNECTION_FLOW.md](./RTMS_CONNECTION_FLOW.md) - Protocol details with code examples
- [MEDIA_PARAMETERS.md](./MEDIA_PARAMETERS.md) - Audio/video configuration options
- [PRODUCTION.md](./PRODUCTION.md) - Distributed architecture & scaling
